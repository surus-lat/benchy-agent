// Runs for every request to the Pages site (static and /api/*). The only job:
// keep exactly one origin in use. The pages.dev production alias 301s to the
// canonical domain; preview deployments (<hash>.benchy-agent.pages.dev) are
// left alone so they stay browsable. `_redirects` cannot do this -- Pages
// does not apply it to requests handled by Functions.
const ALIAS = "benchy-agent.pages.dev";
const CANONICAL = "getbenchy.lat";

export const onRequest: PagesFunction = ({ request, next }) => {
  const url = new URL(request.url);
  if (url.hostname === ALIAS) {
    url.hostname = CANONICAL;
    return Response.redirect(url.toString(), 301);
  }
  return next();
};
