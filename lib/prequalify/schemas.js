'use strict';

const { z } = require('zod');

/**
 * Esquemas de entrada de la precualificacion, uno por paso del wizard.
 *
 * Los nombres de campo y los valores permitidos estan portados del formulario
 * legacy (`vigpr-joomla/prequalify/index.php` + los `accion*.php`), no
 * inventados. Se pasa a camelCase en la API; el mapeo a los campos de
 * Salesforce vive en el puerto de Salesforce (Tarea B5), no aqui.
 *
 * El legacy no validaba practicamente nada: leia `$_POST['ssn']` y lo mandaba
 * crudo a Salesforce. La validacion de formato que se agrega abajo es
 * requisito de seguridad (CLAUDE.md), no una regla de negocio nueva.
 */

// ---------------------------------------------------------------------------
// Primitivas reutilizables
// ---------------------------------------------------------------------------

const trimmed = z.string().trim();

const email = trimmed
  .min(1, 'El email es requerido')
  .max(254)
  .email('Email invalido');

/**
 * Telefono de PR/EEUU: 10 digitos, con o sin separadores. Se normaliza a solo
 * digitos para que el dedupe por telefono (Tarea B5) compare manzanas con
 * manzanas.
 */
const phone = trimmed
  .transform((value) => value.replace(/\D/g, ''))
  .refine(
    (digits) => digits.length === 10 || (digits.length === 11 && digits.startsWith('1')),
    'Telefono invalido: se esperan 10 digitos'
  )
  .transform((digits) => (digits.length === 11 ? digits.slice(1) : digits));

const personName = trimmed
  .min(1, 'Requerido')
  .max(80)
  .regex(/^[\p{L}\p{M}'\-. ]+$/u, 'Solo letras, espacios, apostrofes y guiones');

/**
 * SSN: 9 digitos, con o sin guiones. Se rechazan los rangos que la SSA nunca
 * emite (area 000/666/900-999, grupo 00, serie 0000). Es una regla publica de
 * formato, no un criterio de credito.
 *
 * El valor normalizado son 9 digitos sin guiones. NUNCA debe aparecer en logs,
 * respuestas ni JWT.
 */
const ssn = trimmed
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine((digits) => /^\d{9}$/.test(digits), 'SSN invalido: se esperan 9 digitos')
  .refine((digits) => {
    const area = digits.slice(0, 3);
    const group = digits.slice(3, 5);
    const serial = digits.slice(5);
    if (area === '000' || area === '666' || area[0] === '9') return false;
    if (group === '00') return false;
    if (serial === '0000') return false;
    return true;
  }, 'SSN invalido');

/**
 * Fecha de nacimiento en ISO `YYYY-MM-DD`.
 *
 * El legacy aceptaba cualquier cosa que `strtotime()` entendiera y luego la
 * reformateaba a `Y-m-d` para Salesforce y a `mdY` para Experian
 * (`accionSalesforce.php:57-59`). La API fija ISO para no depender de la
 * ambiguedad de `strtotime`; las dos conversiones de salida son cosa de los
 * puertos.
 *
 * Se valida que la fecha exista, no sea futura y sea plausible. TODO(Roberto):
 * confirmar si debe exigirse una edad minima (18) — el legacy no la exigia, y
 * ponerla aqui rechazaria solicitantes que hoy el sistema acepta.
 */
const MAX_AGE_YEARS = 120;
const dateOfBirth = trimmed
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha invalida: se espera YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return false;
    // Descarta fechas "corridas" por el parser (p. ej. 2026-02-31 -> 03-03).
    return parsed.toISOString().slice(0, 10) === value;
  }, 'Fecha invalida')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    const now = new Date();
    if (parsed.getTime() > now.getTime()) return false;
    const oldest = new Date(now.getTime());
    oldest.setUTCFullYear(oldest.getUTCFullYear() - MAX_AGE_YEARS);
    return parsed.getTime() >= oldest.getTime();
  }, 'Fecha de nacimiento fuera de rango');

/** Estado de 2 letras (PR incluido). */
const stateCode = trimmed
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{2}$/.test(value), 'Estado invalido: se esperan 2 letras');

/** ZIP de 5 digitos, o ZIP+4. */
const zipCode = trimmed.regex(/^\d{5}(-\d{4})?$/, 'ZIP invalido');

const money = z
  .coerce
  .number({ invalid_type_error: 'Debe ser un numero' })
  .finite('Debe ser un numero')
  .nonnegative('No puede ser negativo')
  .max(100_000_000, 'Monto fuera de rango');

const years = z.coerce.number().int().min(0).max(100);
const months = z.coerce.number().int().min(0).max(11);

// Valores tomados literalmente de los radios de `index.php`.
const citizenship = z.enum([
  'U.S. Citizen',
  'Permanent Resident Alien',
  'Non-Permanent Resident Alien',
]);
const maritalStatus = z.enum(['Married', 'Single', 'Unmarried']);
const housing = z.enum(['No primary housing expense', 'Own', 'Rent']);
const typeOfCredit = z.enum(['IndividualCredit', 'CoborrowerCredit']);
const incomeFrequency = z.enum(['Biweekly', 'Semimonthly', 'Weekly']);
const loanPurpose = z.enum(['Compra', 'Refinancia']);

// ---------------------------------------------------------------------------
// Direcciones
// ---------------------------------------------------------------------------

/**
 * Base comun de las tres direcciones. `rentMonth` solo tiene sentido si se
 * alquila; el legacy mostraba/ocultaba ese input segun el radio `Housing`.
 */
const addressBase = z
  .object({
    line1: trimmed.min(1, 'La direccion es requerida').max(255),
    unit: trimmed.max(50).optional(),
    city: trimmed.min(1, 'La ciudad es requerida').max(100),
    state: stateCode,
    zipCode,
    housing,
    rentMonth: money.optional(),
    years,
    months,
  })
  .superRefine((value, ctx) => {
    if (value.housing === 'Rent' && value.rentMonth == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rentMonth'],
        message: 'El alquiler mensual es requerido cuando la vivienda es alquilada',
      });
    }
    if (value.years === 0 && value.months === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['years'],
        message: 'El tiempo en la direccion no puede ser cero',
      });
    }
  });

// ---------------------------------------------------------------------------
// Esquemas por paso
// ---------------------------------------------------------------------------

/** `start`: crea o recupera el lead. Portado de `accionCrearLead.php`. */
const startSchema = z.object({
  email,
  phone,
  firstName: personName,
  lastName: personName,
  dob: dateOfBirth,
  loanPurpose,
  leadSource: trimmed.max(100).optional(),
  referredBy: trimmed.max(100).optional(),
  originator: trimmed.max(100).optional(),
});

/** `POST /prequalify/otp`: pide el codigo. La respuesta NUNCA lo incluye. */
const otpRequestSchema = z
  .object({
    channel: z.enum(['sms', 'whatsapp', 'email']),
    email: email.optional(),
    phone: phone.optional(),
  })
  .superRefine((value, ctx) => {
    const needsPhone = value.channel === 'sms' || value.channel === 'whatsapp';
    if (needsPhone && !value.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phone'],
        message: 'El telefono es requerido para sms y whatsapp',
      });
    }
    if (value.channel === 'email' && !value.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['email'],
        message: 'El email es requerido para el canal email',
      });
    }
  });

/** `otpVerify`: canjea el codigo por un token de sesion. */
const otpVerifySchema = z
  .object({
    code: trimmed.regex(/^\d{6}$/, 'El codigo debe tener 6 digitos'),
    email: email.optional(),
    phone: phone.optional(),
  })
  .refine(
    (value) => Boolean(value.email || value.phone),
    { path: ['email'], message: 'Se requiere email o telefono' }
  );

/**
 * `personal`: datos personales y SSN. Portado de `accionSalesforce.php`.
 * El co-deudor solo se pide si el credito es conjunto.
 */
const personalSchema = z
  .object({
    middleName: personName.optional(),
    dob: dateOfBirth,
    ssn,
    citizenship,
    maritalStatus,
    dependents: z.coerce.number().int().min(0).max(20),
    typeOfCredit,
    coborrowerEmail: email.optional(),
    coborrowerPhone: phone.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.typeOfCredit === 'CoborrowerCredit' && !value.coborrowerEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coborrowerEmail'],
        message: 'El email del co-deudor es requerido en credito conjunto',
      });
    }
  });

const currentAddressSchema = addressBase;
const previousAddressSchema = addressBase;
const mailingAddressSchema = addressBase;

/** `employment`: portado de `accionEmployment_SelfEmployment.php`. */
const employmentSchema = z.object({
  employerBusinessName: trimmed.min(1, 'Requerido').max(150),
  positionTitle: trimmed.min(1, 'Requerido').max(150),
  startDate: trimmed.regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha invalida: se espera YYYY-MM-DD'),
  employerPhone: phone,
  employedByFamily: z.coerce.boolean(),
  line1: trimmed.min(1, 'Requerido').max(255),
  unit: trimmed.max(50).optional(),
  city: trimmed.min(1, 'Requerido').max(100),
  state: stateCode,
  zipCode,
  yearsEmployment: years,
  monthsEmployment: months,
});

/**
 * `income`: portado de `accionIncome.php`.
 *
 * `netPay1..4` son los cuatro talonarios que pide el formulario;
 * `monthlyIncome` y `totalIncome` los calcula hoy el JS del cliente.
 *
 * TODO(Roberto): que el backend recalcule el ingreso a partir de los
 * talonarios y la frecuencia en vez de confiar en el total que manda el
 * cliente. No se hace aqui porque la formula exacta del legacy vive en el JS
 * y hay que portarla con cuidado (Tarea B6, junto con las reglas de decision).
 */
const incomeSchema = z
  .object({
    incomeFrequency,
    netPay1: money,
    netPay2: money,
    netPay3: money,
    netPay4: money,
    monthlyIncome: money,
    totalIncome: money,
    businessOwnerOrSelfEmployed: z.coerce.boolean(),
    retiredOrPensioner: z.coerce.boolean(),
    paysChildSupport: z.coerce.boolean(),
    childSupportAmount: money.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.paysChildSupport && value.childSupportAmount == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['childSupportAmount'],
        message: 'El monto es requerido si paga pension alimentaria',
      });
    }
  });

/** `coborrower`: portado de `accionCrearLeadCoBorrower.php`. */
const coborrowerSchema = z.object({
  firstName: personName,
  lastName: personName,
  email,
  phone,
  dob: dateOfBirth,
});

/** Esquema por paso, para que el router resuelva el validador por nombre. */
const stepSchemas = {
  start: startSchema,
  otpVerify: otpVerifySchema,
  personal: personalSchema,
  currentAddress: currentAddressSchema,
  previousAddress: previousAddressSchema,
  mailingAddress: mailingAddressSchema,
  employment: employmentSchema,
  income: incomeSchema,
  coborrower: coborrowerSchema,
};

module.exports = {
  // primitivas (utiles para componer y para los tests)
  email,
  phone,
  personName,
  ssn,
  dateOfBirth,
  stateCode,
  zipCode,
  money,
  citizenship,
  maritalStatus,
  housing,
  typeOfCredit,
  incomeFrequency,
  loanPurpose,
  // por paso
  startSchema,
  otpRequestSchema,
  otpVerifySchema,
  personalSchema,
  currentAddressSchema,
  previousAddressSchema,
  mailingAddressSchema,
  employmentSchema,
  incomeSchema,
  coborrowerSchema,
  stepSchemas,
};
