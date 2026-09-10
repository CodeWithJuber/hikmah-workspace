import {builtInTools} from './builtin-tools';
import type {ToolDefinition} from './transport.ts';
import type {Preferences} from './session';
import type {McpConnection} from './workspace-config';
import type {McpTool} from './mcp-client';
import {localTools} from './workspace-tools';
import {connectorTools} from './connector-tools';
export const memoryTool:ToolDefinition={type:'function',function:{name:'suggest_memory',description:'Suggest a durable memory from an EXACT quote of the current user message. Use for an explicitly requested memory or a reusable user preference/project fact. Suggestions require user review before retrieval, and do not train the model.',parameters:{type:'object',properties:{title:{type:'string'},quote:{type:'string'},kind:{type:'string',enum:['preference','reference']}},required:['title','quote','kind'],additionalProperties:false}}};
export function resolveRunTools(input:{modelTools?:boolean;preferences:Preferences;connectors:McpConnection[];catalogs:Record<string,McpTool[]>;question?:ToolDefinition;memory?:boolean}):ToolDefinition[]|undefined{
 if(input.modelTools===false)return undefined;
 const selected=[...localTools,...builtInTools].filter(t=>input.preferences.enabledTools.includes(t.function.name)&&(input.preferences.allowEdits||t.function.name!=='write_file'));
 const connected=input.connectors.some(c=>c.enabled&&input.catalogs[c.id]?.length);
 const tools=[...(input.memory===false?[]:[memoryTool]),...(input.question?[input.question]:[]),...selected,...(connected?connectorTools:[])];return tools.length?tools:undefined;
}
