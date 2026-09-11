import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-sync';

/** The compiled WASM module, booted once.
 *
 * Instantiating it costs seconds on a modest machine, and it was being redone
 * on every single run — inside the same budget the program itself had to finish
 * in, which is why a first run so often reported a timeout rather than a result.
 * The module is stateless; each run still gets its own runtime and context, so
 * nothing carries between programs.
 */
let module_: Promise<Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>> | undefined;

export function quickJsModule() {
  // A failed boot is not cached: a reload should be able to try again.
  module_ ??= newQuickJSWASMModuleFromVariant(variant).catch((error: unknown) => {
    module_ = undefined;
    throw error;
  });
  return module_;
}

export async function evaluateJavascript(code: string) {
  if (typeof code !== 'string' || !code.trim() || code.length > 40000)
    throw Error('Enter JavaScript up to 40,000 characters.');
  const QuickJS = await quickJsModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const start = Date.now();
  runtime.setInterruptHandler(() => Date.now() - start > 3000);
  const vm = runtime.newContext();
  try {
    // Output serialization happens inside the guest, so it is subject to its CPU/memory limits.
    const setup = vm.evalCode(
      `globalThis.__lines=[];globalThis.__outputSize=0;globalThis.console=Object.freeze({log:(...xs)=>{const line=xs.map(x=>typeof x==='string'?x:JSON.stringify(x)??String(x)).join(' ');__outputSize+=line.length;if(__outputSize>24000)throw Error('Output limit: 24,000 characters');__lines.push(line);}});`,
    );
    if (setup.error) {
      setup.error.dispose();
      throw Error('Sandbox initialization failed.');
    }
    setup.value.dispose();
    const evaluated = vm.evalCode(code, 'user.js');
    let error = '';
    if (evaluated.error) {
      const v = vm.dump(evaluated.error);
      error = String(v?.message ?? v).slice(0, 1000);
      evaluated.error.dispose();
    } else {
      vm.setProp(vm.global, '__result', evaluated.value);
      evaluated.value.dispose();
    }
    const packed = vm.evalCode(
      String.raw`JSON.stringify({stdout:__lines.join('\n'),result:typeof __result==='undefined'?'':String(__result).slice(0,24000)})`,
    );
    let output = { stdout: '', result: '' };
    if (packed.error) {
      packed.error.dispose();
      error = error || 'Execution interrupted or output could not be serialized.';
    } else {
      const raw = vm.getString(packed.value);
      packed.value.dispose();
      const parsed = JSON.parse(raw.slice(0, 150000));
      const stdout = typeof parsed?.stdout === 'string' ? parsed.stdout.slice(0, 24000) : '';
      output = {
        stdout,
        result:
          typeof parsed?.result === 'string' ? parsed.result.slice(0, 24000 - stdout.length) : '',
      };
    }
    return {
      runtime: 'QuickJS · isolated JavaScript',
      ...output,
      error: error || undefined,
      elapsedMs: Date.now() - start,
      network: false,
      hostAccess: false,
    };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
