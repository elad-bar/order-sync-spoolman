/**
 * Inventory Color column → display hexes + Spoolman direction.
 * Hexes are uppercase, no "#", Spoolman-compatible.
 */

const NAME_TO_HEX = {
  black: "1A1A1A",
  white: "F5F5F5",
  "cold white": "ECEFF1",
  "bone white": "E8E0D5",
  "natural white": "F5F5DC",
  red: "C62828",
  blue: "1565C0",
  green: "2E7D32",
  yellow: "FDD835",
  orange: "FB8C00",
  grey: "9E9E9E",
  gray: "9E9E9E",
  "light gray": "BDBDBD",
  "light grey": "BDBDBD",
  brown: "6D4C41",
  "warm brown": "6D4C41",
  "olive green": "556B2F",
  "wood-like": "8D6E63",
  copper: "B87333",
  transparent: "E0E0E0",
  matte: "B0B0B0",
};

function stripParens(s) {
  return (s || "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

/** Split Color cell into labeled segments (dual / multi on one spool). */
function splitColorSegments(colorCell) {
  const core = stripParens(colorCell);
  if (!core) return [];
  if (core.includes(" / ")) {
    return core
      .split(" / ")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (/\s*\+\s*/.test(core)) {
    return core
      .split(/\s*\+\s*/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [core];
}

function phraseToHex(phrase) {
  const p = phrase.toLowerCase().trim();
  if (!p) return null;
  if (p.startsWith("#") && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(p)) {
    return p.slice(1).toUpperCase();
  }
  const keys = Object.keys(NAME_TO_HEX).sort((a, b) => b.length - a.length);
  const words = p.split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const tail = words.slice(i).join(" ");
    if (NAME_TO_HEX[tail]) return NAME_TO_HEX[tail];
    if (NAME_TO_HEX[words[i]]) return NAME_TO_HEX[words[i]];
  }
  for (const name of keys) {
    if (p.includes(name)) return NAME_TO_HEX[name];
  }
  return "B0B0B0";
}

/**
 * From one inventory table row, infer colors and Spoolman multi_color_direction.
 * Single-color: color_direction null. Multi: direction set (coaxial vs longitudinal).
 */
export function inferColorsFromInventoryRow(r) {
  const colorCell = r.color || "";
  const item = (r.item_name || "").toLowerCase();
  const product = (r.product_name || "").toLowerCase();
  const cLow = colorCell.toLowerCase();

  if (
    cLow.includes("rainbow") ||
    cLow.includes("gradient") ||
    product.includes("rainbow") ||
    product.includes("gradient")
  ) {
    return {
      colors: ["FF0000", "FF8800", "FFFF00", "00CC00", "0066FF", "8800FF"],
      color_direction: "longitudinal",
    };
  }

  if (
    item.includes("black / red") ||
    item.includes("black/red") ||
    (cLow.includes("black") &&
      cLow.includes("red") &&
      (cLow.includes("/") || colorCell.includes(" / ")))
  ) {
    return {
      colors: ["000000", "C62828"],
      color_direction: "coaxial",
    };
  }

  const segments = splitColorSegments(colorCell);
  const hexes = [...new Set(segments.map(phraseToHex).filter(Boolean))];

  if (hexes.length > 1) {
    return { colors: hexes, color_direction: "coaxial" };
  }
  if (hexes.length === 1) {
    return { colors: hexes, color_direction: null };
  }
  return { colors: ["B0B0B0"], color_direction: null };
}
