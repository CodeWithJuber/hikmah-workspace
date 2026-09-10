export interface ProviderDiagnostic { code: string; category: string; message: string; action: string; parameter?: string; status?: number; retryAfterSeconds?: number }
const known: Record<string, [string,string,string]> = {
  invalid_key: ['authentication','The provider did not accept this API key.','Replace the key in Settings → Connection.'],
  invalid_api_key: ['authentication','The provider did not accept this API key.','Replace the key in Settings → Connection.'],
  unsupported_parameter: ['compatibility','This model rejected an optional request parameter.','Turn off custom sampling in Settings. If a token field is named, change the token parameter under Advanced connection.'],
  invalid_parameter: ['compatibility','A request parameter is outside this model’s supported range.','Use provider defaults for sampling and check the output limit.'],
  unsupported_capability: ['compatibility','This model does not support a requested feature.','Try Chat without tools, or choose a model that supports tool calling.'],
  model_not_granted: ['model','This model is not available to your provider account.','Load your available models in Settings and choose an exact model ID from that list.'],
  model_not_found: ['model','The provider could not find this model.','Load the available models and select an exact model ID.'],
  insufficient_quota: ['quota','The provider account has reached its credits or usage limit.','Check your provider dashboard. Repeated retries will not resolve an account limit.'],
  verification_required: ['quota','The provider account requires verification before generation.','Complete the required account setup in the provider dashboard.'],
  rate_limit_exceeded: ['rate_limit','The provider is limiting requests right now.','Wait before retrying, or choose a different available model.'],
  all_routes_failed: ['routing','The provider could not complete a route for this model.','Keep custom sampling off. Try another available model, or check the provider’s routing and connected accounts.'],
  provider_internal: ['upstream','The upstream model stopped unexpectedly.','Try again after a short wait, or choose another model.'],
  provider_unavailable: ['upstream','No provider is available for this model right now.','Choose another free model or wait for capacity to return.'],
  provider_overloaded: ['upstream','The model provider is overloaded.','Wait before retrying or select another free model.'],
  permission_denied: ['authentication','Your provider account is not permitted to use this route.','Check account access and data-policy settings in the provider dashboard.'],
  timeout: ['upstream','The upstream model timed out.','Your partial answer is preserved. Retry when the provider is available.'],
  server_error: ['upstream','The provider encountered a generation error.','Try again after a short wait, or choose another model.'],
  context_length_exceeded: ['context','This conversation exceeds the model’s context window.','Start a new chat or lower the prior-context budget in Run settings.'],
  refusal: ['refusal','The provider declined this request.','Review the request and the provider’s usage rules.'],
  invalid_request: ['request','The provider rejected the request format.','Run the connection test with custom sampling off, then check the selected model.'],
  invalid_json: ['request','The provider could not read the request.','Run the connection test and report its diagnostic code if this continues.'],
};
const record=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export function hasProviderError(data: unknown): boolean {
  if (!record(data)) return false;
  const e=data.error;
  return typeof e==='string' ? e.trim().length>0 : e===true || (record(e)&&Object.values(e).some(v=>v!==null&&v!==undefined&&v!==''&&v!==false));
}
/** Preserve useful machine codes, never arbitrary provider prose or echoed input. */
export function diagnoseProviderError(data: unknown, status?: number): ProviderDiagnostic {
  const error=record(data)&&record(data.error)?data.error:{};
  const metadata=record(error.metadata)?error.metadata:{};
  const numeric=Number(error.code);const effectiveStatus=Number.isInteger(numeric)&&numeric>=400&&numeric<=599?numeric:status;
  let code=typeof metadata.error_type==='string'&&Object.hasOwn(known,metadata.error_type)?metadata.error_type:'';
  if(!code)code=typeof error.code==='string'&&Object.hasOwn(known,error.code)?error.code:'';
  if(!code&&typeof error.type==='string'&&Object.hasOwn(known,error.type))code=error.type;
  if(!code)code=effectiveStatus===401?'invalid_key':effectiveStatus===402?'insufficient_quota':effectiveStatus===403?'permission_denied':effectiveStatus===429?'rate_limit_exceeded':effectiveStatus===404?'model_not_found':effectiveStatus===400?'invalid_request':effectiveStatus===503?'provider_unavailable':[408,504].includes(effectiveStatus??0)?'timeout':'server_error';
  const [category,message,action]=known[code];
  const parameter=typeof error.param==='string'&&['temperature','top_p','max_tokens','max_completion_tokens','tools','stream','messages','model','reasoning_effort'].includes(error.param)?error.param:undefined;
  return {code,category,message:message+(parameter?` Parameter: ${parameter}.`:''),action,parameter,status:effectiveStatus};
}
