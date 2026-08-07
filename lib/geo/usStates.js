'use strict';

/**
 * Estados, territorios y codigos militares de EEUU (codigos USPS).
 *
 * El legacy sacaba esta lista de una tabla MySQL (`getStates.php` ->
 * `SELECT DISTINCT state_short, state_full FROM us_cities_states_counties`).
 * No hace falta una base de datos ni una API para 56 filas que no cambian:
 * viven aqui, se sirven al instante y no dependen de que un tercero este
 * arriba.
 *
 * VIG acepta solicitantes de **todo EEUU**, no solo de Puerto Rico (verificado
 * contra el flujo legacy: no habia ningun filtro por estado).
 */

/** Los 50 estados y DC. */
const STATES = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
});

/** Territorios. PR es el mercado principal de VIG. */
const TERRITORIES = Object.freeze({
  PR: 'Puerto Rico',
  VI: 'U.S. Virgin Islands',
  GU: 'Guam',
  AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
});

/** Direcciones militares (APO/FPO/DPO). Un solicitante desplegado las usa. */
const MILITARY = Object.freeze({
  AA: 'Armed Forces Americas',
  AE: 'Armed Forces Europe',
  AP: 'Armed Forces Pacific',
});

const US_STATES = Object.freeze({ ...STATES, ...TERRITORIES, ...MILITARY });

const STATE_CODES = Object.freeze(Object.keys(US_STATES));

/** ¿Es un codigo USPS valido? Acepta minusculas. */
function isValidStateCode(value) {
  if (typeof value !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(US_STATES, value.trim().toUpperCase());
}

/** Nombre completo del estado, o null. */
function stateName(code) {
  if (!isValidStateCode(code)) return null;
  return US_STATES[code.trim().toUpperCase()];
}

/** Lista para poblar un dropdown, ordenada por nombre. */
function listStates() {
  return STATE_CODES.map((code) => ({ code, name: US_STATES[code] })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en')
  );
}

module.exports = {
  STATES,
  TERRITORIES,
  MILITARY,
  US_STATES,
  STATE_CODES,
  isValidStateCode,
  stateName,
  listStates,
};
