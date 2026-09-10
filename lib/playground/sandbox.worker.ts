import {evaluateJavascript} from './sandbox-core';
self.onmessage=async(event:MessageEvent<{code:string}>)=>{try{self.postMessage({value:await evaluateJavascript(event.data.code)});}catch(e){self.postMessage({error:e instanceof Error?e.message:'Sandbox failed.'});}};
