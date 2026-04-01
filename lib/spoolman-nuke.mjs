/**
 * Delete all Spoolman catalog data (spools → filaments → vendors).
 * Extra field *definitions* for filaments remain (stored in settings); only
 * entity rows are removed.
 */

import { api, fetchPaged } from "./spoolman-client.mjs";

export async function nukeSpoolmanData(base, { apply = false } = {}) {
  const spools = await fetchPaged(base, "spool");
  const filaments = await fetchPaged(base, "filament");
  const vendors = await fetchPaged(base, "vendor");

  console.log(
    `Spoolman nuke preview: ${spools.length} spool(s), ${filaments.length} filament(s), ${vendors.length} vendor(s)`,
  );

  if (!apply) return { spools: spools.length, filaments: filaments.length, vendors: vendors.length };

  for (const s of spools) {
    await api(base, "DELETE", `/api/v1/spool/${s.id}`);
  }
  for (const f of filaments) {
    await api(base, "DELETE", `/api/v1/filament/${f.id}`);
  }
  for (const v of vendors) {
    await api(base, "DELETE", `/api/v1/vendor/${v.id}`);
  }

  console.log("Nuke complete (all spools, filaments, vendors deleted).");
  return { spools: spools.length, filaments: filaments.length, vendors: vendors.length };
}
