// Pages Function: forward every /api/* request to the API Worker over the
// `API` Service Binding. Runs on the same origin as the SPA, so the Worker's
// auth cookies are first-party in the browser. No logic belongs here.
export const onRequest: PagesFunction<{ API: Fetcher }> = ({ request, env }) =>
  env.API.fetch(request);
