/** The first real screen, and where anything unrecognised lands.
 *
 * It used to be 'workspace', which was the browser-run chat. That chat is gone
 * — conversations belong to /chat and to the server — so 'workspace' is not a
 * page of this shell any more, and a fallback pointing at it would render an
 * empty panel. */
export const DEFAULT_PAGE = 'agents';

const pages = new Set([
  'agents',
  'tools',
  'terminal',
  'connections',
  'typeform',
  'knowledge',
  'learning',
  'kernel',
  'labs',
  'admin',
  'admin/overview',
  'admin/providers',
  'admin/media',
  'admin/connectors',
  'admin/skills',
  'admin/plan',
  'superadmin',
  'superadmin/context',
  'superadmin/overview',
  'superadmin/versions',
  'superadmin/architecture',
  'superadmin/training',
  'superadmin/learning',
  'superadmin/runs',
  'superadmin/controls',
  'superadmin/integrations',
]);
export function workspaceDestination(hash: string): string {
  const page = hash.replace(/^#\/?/, '');
  return pages.has(page) ? page : DEFAULT_PAGE;
}
