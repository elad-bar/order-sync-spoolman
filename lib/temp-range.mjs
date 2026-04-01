/**
 * Parse inventory table cells like "190–220" or "50–60" (en dash or hyphen).
 * Returns null if unparseable.
 */

export function parseTempRangeCell(cell) {
  const s = String(cell || "").trim();
  if (!s) return null;
  const parts = s.split(/\s*[–-]\s*/u).map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const nums = parts
    .map((p) => parseInt(p.replace(/[^\d-]/g, ""), 10))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  if (nums.length === 1) return { min: nums[0], max: nums[0] };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}
