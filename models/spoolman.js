/**
 * Spoolman API: extra-field keys and field-definition payloads (no I/O).
 */

export const FILAMENT_EXTRA_NOZZLE_KEY = "nozzle_temp_range";
export const FILAMENT_EXTRA_BED_KEY = "bed_temp_range";
export const SPOOL_EXTRA_AMAZON_ORDER_KEY = "amazon_order_id";

export const FILAMENT_EXTRA_FIELD_DEFINITIONS = [
  {
    key: FILAMENT_EXTRA_NOZZLE_KEY,
    body: {
      name: "Nozzle temperature (min–max °C)",
      order: 0,
      unit: "°C",
      field_type: "integer_range",
    },
  },
  {
    key: FILAMENT_EXTRA_BED_KEY,
    body: {
      name: "Bed temperature (min–max °C)",
      order: 1,
      unit: "°C",
      field_type: "integer_range",
    },
  },
];

export const SPOOL_EXTRA_FIELD_DEFINITIONS = [
  {
    key: SPOOL_EXTRA_AMAZON_ORDER_KEY,
    body: {
      name: "Amazon order ID",
      order: 0,
      field_type: "text",
    },
  },
];
