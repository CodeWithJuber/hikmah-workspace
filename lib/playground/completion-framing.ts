/** Content-driven framing. Provider MIME labels are hints, never the parser selector.
 * Streams have no aggregate wire-byte cap; each buffered record is bounded.
 */
export class FramingError extends Error {}
export class CompletionFramer {
  private mode: 'sse'|'objects'|undefined;
  private prefix=''; private line=''; private data:string[]=[]; private event='';
  private eventSize=0; private cr=false; private stopped=false;
  private json=''; private depth=0; private quoted=false; private escaped=false;
  private emit:(value:unknown,streaming:boolean)=>boolean|void;
  private maxRecord:number;
  constructor(emit:(value:unknown,streaming:boolean)=>boolean|void,maxRecord=16_000_000){this.emit=emit;this.maxRecord=maxRecord;}
  private parse(text:string):unknown{try{return JSON.parse(text);}catch{throw new FramingError('The provider sent a malformed response record. Your partial answer is preserved. Try another model or turn off streaming in Connection settings.');}}
  private lineEnd(){const line=this.line;this.line='';if(!line){
    const value=this.data.join('\n');
    if(value.trim()==='[DONE]')this.stopped=true;
    else if(value.trim()&&!(['ping','heartbeat','keepalive'].includes(this.event)&&!value.trim().startsWith('{'))){if(this.emit(this.parse(value),true)===false)this.stopped=true;}
    this.data=[];this.event='';this.eventSize=0;
  }else if(line==='data'||line.startsWith('data:')){const value=line==='data'?'':line.slice(line[5]===' '?6:5);this.eventSize+=value.length+1;if(this.eventSize>this.maxRecord)throw new FramingError('A single provider event is too large to process safely. The partial answer is preserved.');this.data.push(value);}
  else if(line.startsWith('event:'))this.event=line.slice(6).trim();}
  feed(chunk:string):boolean{
    if(this.stopped)return false;
    if(!this.mode){this.prefix+=chunk;const first=this.prefix.replace(/^\uFEFF/,'').trimStart();if(!first){if(this.prefix.length>4096)throw new FramingError('The provider returned only whitespace.');return true;}
      if(first[0]==='{')this.mode='objects';
      else if(first[0]===':'||/^(data|event|id|retry)(:|\r|\n)/.test(first))this.mode='sse';
      else if(first[0]==='<')throw new FramingError('The API returned an HTML page instead of a model response. Check the API base URL or provider gateway status.');
      else if(first.length>32)throw new FramingError('The API returned neither completion JSON nor an event stream. Check the provider endpoint.');
      if(!this.mode)return true;chunk=first;this.prefix='';
    }
    for(const c of chunk){if(this.stopped)return false;
      if(this.mode==='sse'){if(this.cr){this.cr=false;if(c==='\n')continue;}if(c==='\r'||c==='\n'){this.lineEnd();this.cr=c==='\r';}else{this.line+=c;if(this.line.length>this.maxRecord)throw new FramingError('A single provider event exceeds the supported record size.');}}
      else{if(!this.depth){if(/\s/.test(c))continue;if(c!=='{')throw new FramingError('Unexpected data after a completion record. The partial answer is preserved.');}
        this.json+=c;if(this.json.length>this.maxRecord)throw new FramingError('A single provider JSON response exceeds 16 MB. Use streaming for long answers.');
        if(this.quoted){if(this.escaped)this.escaped=false;else if(c==='\\')this.escaped=true;else if(c==='"')this.quoted=false;}
        else if(c==='"')this.quoted=true;else if(c==='{'||c==='[')this.depth++;else if(c==='}'||c===']')this.depth--;
        if(this.depth===0){const obj=this.parse(this.json);this.json='';const choices=(obj as {choices?:{delta?:unknown}[]})?.choices;const stream=Array.isArray(choices)&&(!choices.length||choices.some(c=>c!==null&&typeof c==='object'&&c.delta!==undefined));if(this.emit(obj,stream)===false)this.stopped=true;}
      }
    }return !this.stopped;
  }
  finish(){if(this.mode==='sse'&&!this.stopped){if(this.line)this.lineEnd();if(this.data.length)this.lineEnd();}if(this.mode==='objects'&&this.json.trim())throw new FramingError('The provider connection ended inside a JSON record. Your partial answer is preserved.');if(!this.mode)throw new FramingError('The provider returned an empty or unsupported response.');return {streaming:this.mode==='sse',done:this.stopped};}
}
