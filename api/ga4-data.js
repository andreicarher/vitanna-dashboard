// GA4 Data API: valores únicos por rango, no sumas de usuarios por día.
import { createSign } from 'node:crypto';
import { createHandler, requireEnv, httpError } from '../lib/common.js';

let cachedToken = { token: null, expiresAt: 0 };
const b64 = value => Buffer.from(value).toString('base64url');
async function accessToken() {
  if (cachedToken.token && Date.now() < cachedToken.expiresAt - 60000) return cachedToken.token;
  const now = Math.floor(Date.now()/1000);
  const assertion = `${b64(JSON.stringify({alg:'RS256',typ:'JWT'}))}.${b64(JSON.stringify({iss:process.env.GA4_CLIENT_EMAIL,scope:'https://www.googleapis.com/auth/analytics.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}))}`;
  let signature;
  try { signature = createSign('RSA-SHA256').update(assertion).end().sign(process.env.GA4_PRIVATE_KEY.replace(/\\n/g,'\n'),'base64url'); }
  catch { throw httpError(500, 'La clave privada de la cuenta de servicio de GA4 no es válida.', 'config'); }
  const res = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${assertion}.${signature}`}) });
  const json = await res.json().catch(()=>({}));
  if (!res.ok || !json.access_token) throw httpError(502, 'No se pudo autenticar la cuenta de servicio de GA4. Revisa sus credenciales.');
  cachedToken = {token:json.access_token,expiresAt:Date.now()+Number(json.expires_in||3600)*1000};
  return cachedToken.token;
}
async function report(range, dimensions, metrics, token) {
  const body = {dateRanges:[{startDate:range.since,endDate:range.until}],dimensions:dimensions.map(name=>({name})),metrics:metrics.map(name=>({name})),limit:'10000'};
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${process.env.GA4_PROPERTY_ID}:runReport`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw httpError(502, `GA4: ${data.error?.message || `HTTP ${res.status}`}`);
  if (data.rowCount > 10000) throw httpError(502,'GA4 devolvió demasiados canales; no se mostrará un resultado incompleto.');
  return data;
}
function metric(value) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n) || n < 0) throw httpError(502,'GA4 devolvió una métrica inválida.');
  return n;
}
async function fetchGA4(range) {
  requireEnv(['GA4_PROPERTY_ID','GA4_CLIENT_EMAIL','GA4_PRIVATE_KEY']);
  if (!/^\d+$/.test(process.env.GA4_PROPERTY_ID)) throw httpError(500,'GA4_PROPERTY_ID debe ser el ID numérico de la propiedad.','config');
  const token = await accessToken();
  const [totals, channels] = await Promise.all([
    report(range,[],['activeUsers','sessions'],token),
    report(range,['sessionDefaultChannelGroup'],['sessions'],token),
  ]);
  const row = totals.rows?.[0];
  const meta = [totals.metadata,channels.metadata];
  return {activeUsers:row ? metric(row.metricValues?.[0]?.value):totals.metadata?.subjectToThresholding ? null : 0, sessions:row ? metric(row.metricValues?.[1]?.value):totals.metadata?.subjectToThresholding ? null : 0,
    channels:(channels.rows||[]).map(r=>({channel:r.dimensionValues?.[0]?.value || '(Sin asignar)', sessions:metric(r.metricValues?.[0]?.value)})),
    meta:{timeZone:totals.metadata?.timeZone || null, thresholded:meta.some(x=>x?.subjectToThresholding), sampled:meta.some(x=>x?.samplingMetadatas?.length), dataLoss:meta.some(x=>x?.dataLossFromOtherRow)}};
}
export default createHandler({platform:'Google Analytics 4',fetcher:fetchGA4});
export {fetchGA4};
