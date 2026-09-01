'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_AGE_YEARS,
  ageInYears,
  phone,
  ssn,
  dateOfBirth,
  stateCode,
  zipCode,
  startSchema,
  otpRequestSchema,
  otpVerifySchema,
  personalSchema,
  currentAddressSchema,
  employmentSchema,
  incomeSchema,
  coborrowerSchema,
  stepSchemas,
} = require('../lib/prequalify/schemas');

const ok = (schema, value) => schema.safeParse(value);
const falla = (schema, value) => {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, `deberia rechazar: ${JSON.stringify(value)}`);
  return result;
};

// --- primitivas -----------------------------------------------------------

test('phone normaliza a 10 digitos y quita el 1 de pais', () => {
  for (const entrada of ['7871234567', '(787) 123-4567', '787-123-4567', '1 787 123 4567']) {
    const r = ok(phone, entrada);
    assert.equal(r.success, true, `entrada: ${entrada}`);
    assert.equal(r.data, '7871234567');
  }
});

test('phone rechaza longitudes que no son de PR/EEUU', () => {
  for (const entrada of ['', '123', '78712345678', 'abcdefghij']) {
    falla(phone, entrada);
  }
});

test('ssn acepta con y sin guiones y normaliza a 9 digitos', () => {
  assert.equal(ok(ssn, '123-45-6789').data, '123456789');
  assert.equal(ok(ssn, '123456789').data, '123456789');
  assert.equal(ok(ssn, ' 123 45 6789 '.replace(/ /g, '')).data, '123456789');
});

test('ssn rechaza los rangos que la SSA nunca emite', () => {
  falla(ssn, '000-45-6789'); // area 000
  falla(ssn, '666-45-6789'); // area 666
  falla(ssn, '900-45-6789'); // area 9xx
  falla(ssn, '123-00-6789'); // grupo 00
  falla(ssn, '123-45-0000'); // serie 0000
});

test('ssn rechaza formatos malos', () => {
  for (const entrada of ['', '12345', '12345678901', 'abc-de-fghi', '123-45-678']) {
    falla(ssn, entrada);
  }
});

test('dateOfBirth exige ISO y rechaza fechas que no existen', () => {
  assert.equal(ok(dateOfBirth, '1985-06-15').success, true);
  falla(dateOfBirth, '06/15/1985'); // formato legacy, ya no se acepta
  falla(dateOfBirth, '1985-13-01');
  falla(dateOfBirth, '2026-02-31'); // no debe "correrse" a marzo
  falla(dateOfBirth, '');
});

test('dateOfBirth rechaza el futuro y edades imposibles', () => {
  const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  falla(dateOfBirth, manana);
  falla(dateOfBirth, '1800-01-01');
});

test('dateOfBirth exige 21 anos: la mayoria de edad en Puerto Rico, no 18', () => {
  const hoy = new Date();
  const haceAnios = (n) => {
    const d = new Date(Date.UTC(hoy.getUTCFullYear() - n, hoy.getUTCMonth(), hoy.getUTCDate()));
    return d.toISOString().slice(0, 10);
  };
  assert.equal(MIN_AGE_YEARS, 21);
  assert.equal(ok(dateOfBirth, haceAnios(21)).success, true, 'justo 21 debe pasar');
  assert.equal(ok(dateOfBirth, haceAnios(30)).success, true);
  falla(dateOfBirth, haceAnios(20));
  falla(dateOfBirth, haceAnios(18)); // mayoria de edad federal, insuficiente en PR
});

test('ageInYears no cuenta el cumpleanos que aun no llega', () => {
  const referencia = new Date(Date.UTC(2026, 5, 14)); // 14 jun 2026
  assert.equal(ageInYears('2005-06-15', referencia), 20); // cumple manana
  assert.equal(ageInYears('2005-06-14', referencia), 21); // cumple hoy
});

test('stateCode normaliza a mayusculas', () => {
  assert.equal(ok(stateCode, 'pr').data, 'PR');
  falla(stateCode, 'Puerto Rico');
  falla(stateCode, 'P');
});

test('zipCode acepta 5 digitos y ZIP+4', () => {
  assert.equal(ok(zipCode, '00926').success, true);
  assert.equal(ok(zipCode, '00926-1234').success, true);
  falla(zipCode, '926');
  falla(zipCode, 'abcde');
});

// --- start ----------------------------------------------------------------

const START_VALIDO = {
  email: 'juan@example.com',
  phone: '7871234567',
  firstName: 'Juan',
  lastName: 'Del Valle',
  dob: '1985-06-15',
  loanPurpose: 'Compra',
};

test('startSchema acepta el payload minimo', () => {
  const r = ok(startSchema, START_VALIDO);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
});

test('startSchema rechaza email invalido y proposito fuera del enum', () => {
  falla(startSchema, { ...START_VALIDO, email: 'no-es-email' });
  falla(startSchema, { ...START_VALIDO, loanPurpose: 'Construccion' });
});

test('startSchema exige nombre y apellido', () => {
  falla(startSchema, { ...START_VALIDO, firstName: '' });
  falla(startSchema, { ...START_VALIDO, lastName: '   ' });
  // Nombres con acentos, apostrofe y guion son validos.
  assert.equal(ok(startSchema, { ...START_VALIDO, lastName: "O'Neill-Muñiz" }).success, true);
  falla(startSchema, { ...START_VALIDO, firstName: 'Robert<script>' });
});

// --- OTP ------------------------------------------------------------------

test('otpRequestSchema exige correo Y telefono: se verifican los dos', () => {
  const completo = { email: 'a@b.com', phone: '7871234567' };
  assert.equal(ok(otpRequestSchema, completo).success, true);
  // La via del telefono por defecto es SMS.
  assert.equal(ok(otpRequestSchema, completo).data.phoneChannel, 'sms');
  assert.equal(ok(otpRequestSchema, { ...completo, phoneChannel: 'whatsapp' }).success, true);

  falla(otpRequestSchema, { email: 'a@b.com' });          // sin telefono
  falla(otpRequestSchema, { phone: '7871234567' });        // sin correo
  falla(otpRequestSchema, { ...completo, phoneChannel: 'paloma' });
  falla(otpRequestSchema, {});
});

test('otpVerifySchema exige AMBOS codigos de 6 digitos', () => {
  // El nombre es parte del contrato desde 2026-09-01: es donde nace el lead y
  // la org lo exige al insertar. Ver la nota del esquema.
  const base = {
    email: 'a@b.com',
    phone: '7871234567',
    firstName: 'Juan',
    lastName: 'Del Valle',
  };
  assert.equal(
    ok(otpVerifySchema, { ...base, emailCode: '123456', phoneCode: '654321' }).success,
    true
  );
  falla(otpVerifySchema, { ...base, emailCode: '123456' });                  // falta el del telefono
  falla(otpVerifySchema, { ...base, phoneCode: '123456' });                  // falta el del correo
  falla(otpVerifySchema, { ...base, emailCode: '12345', phoneCode: '654321' });
  falla(otpVerifySchema, { ...base, emailCode: 'abcdef', phoneCode: '654321' });
  falla(otpVerifySchema, { emailCode: '123456', phoneCode: '654321' });      // sin destinatarios
});

test('otpVerifySchema exige el nombre: sin el, el lead no se puede crear', () => {
  // Regresion de un fallo real: este endpoint creaba el lead con solo email y
  // telefono, y la regla de validacion de la org ("Debe Ingresar el Nombre del
  // Lead") devolvia 400. El usuario veia "No pudimos completar la operacion"
  // justo despues de teclear sus dos codigos.
  const codigos = { emailCode: '123456', phoneCode: '654321' };
  const contacto = { email: 'a@b.com', phone: '7871234567' };
  falla(otpVerifySchema, { ...contacto, ...codigos });                       // sin nombre ni apellido
  falla(otpVerifySchema, { ...contacto, ...codigos, firstName: 'Juan' });    // falta el apellido
  falla(otpVerifySchema, { ...contacto, ...codigos, lastName: 'Del Valle' }); // falta el nombre
  falla(otpVerifySchema, { ...contacto, ...codigos, firstName: '', lastName: 'Del Valle' });
  assert.equal(
    ok(otpVerifySchema, { ...contacto, ...codigos, firstName: 'Juan', lastName: 'Del Valle' })
      .success,
    true
  );
});

// --- personal -------------------------------------------------------------

const PERSONAL_VALIDO = {
  dob: '1985-06-15',
  ssn: '123-45-6789',
  citizenship: 'U.S. Citizen',
  maritalStatus: 'Single',
  dependents: 0,
  typeOfCredit: 'IndividualCredit',
};

test('personalSchema acepta el payload individual', () => {
  const r = ok(personalSchema, PERSONAL_VALIDO);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  assert.equal(r.data.ssn, '123456789');
});

test('personalSchema valida los enums portados del formulario legacy', () => {
  falla(personalSchema, { ...PERSONAL_VALIDO, citizenship: 'Turista' });
  falla(personalSchema, { ...PERSONAL_VALIDO, maritalStatus: 'Divorced' });
  falla(personalSchema, { ...PERSONAL_VALIDO, typeOfCredit: 'JointCredit' });
});

test('personalSchema exige el email del co-deudor en credito conjunto', () => {
  falla(personalSchema, { ...PERSONAL_VALIDO, typeOfCredit: 'CoborrowerCredit' });
  assert.equal(
    ok(personalSchema, {
      ...PERSONAL_VALIDO,
      typeOfCredit: 'CoborrowerCredit',
      coborrowerEmail: 'co@example.com',
    }).success,
    true
  );
});

test('personalSchema rechaza dependientes negativos o absurdos', () => {
  falla(personalSchema, { ...PERSONAL_VALIDO, dependents: -1 });
  falla(personalSchema, { ...PERSONAL_VALIDO, dependents: 21 });
  falla(personalSchema, { ...PERSONAL_VALIDO, dependents: 1.5 });
});

// --- direcciones ----------------------------------------------------------

const DIRECCION_VALIDA = {
  line1: 'Calle Loiza 1234',
  city: 'San Juan',
  state: 'PR',
  zipCode: '00911',
  housing: 'Own',
  years: 3,
  months: 2,
};

test('currentAddressSchema acepta una direccion completa', () => {
  const r = ok(currentAddressSchema, DIRECCION_VALIDA);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
});

test('currentAddressSchema exige el alquiler cuando la vivienda es alquilada', () => {
  const alquilada = { ...DIRECCION_VALIDA, housing: 'Rent' };
  const r = falla(currentAddressSchema, alquilada);
  assert.ok(r.error.issues.some((i) => i.path.includes('rentMonth')));
  assert.equal(ok(currentAddressSchema, { ...alquilada, rentMonth: 900 }).success, true);
});

test('currentAddressSchema rechaza tiempo cero en la direccion', () => {
  falla(currentAddressSchema, { ...DIRECCION_VALIDA, years: 0, months: 0 });
  assert.equal(ok(currentAddressSchema, { ...DIRECCION_VALIDA, years: 0, months: 6 }).success, true);
});

test('currentAddressSchema valida meses 0-11', () => {
  falla(currentAddressSchema, { ...DIRECCION_VALIDA, months: 12 });
  falla(currentAddressSchema, { ...DIRECCION_VALIDA, months: -1 });
});

// --- empleo ---------------------------------------------------------------

const EMPLEO_VALIDO = {
  employerBusinessName: 'VIG Mortgage',
  positionTitle: 'Analista',
  startDate: '2020-01-15',
  employerPhone: '7879876543',
  employedByFamily: false,
  line1: 'Ave Ponce de Leon 500',
  city: 'San Juan',
  state: 'PR',
  zipCode: '00918',
  yearsEmployment: 5,
  monthsEmployment: 3,
};

test('employmentSchema acepta el payload completo', () => {
  const r = ok(employmentSchema, EMPLEO_VALIDO);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
});

test('employmentSchema exige patrono, puesto y fecha ISO', () => {
  falla(employmentSchema, { ...EMPLEO_VALIDO, employerBusinessName: '' });
  falla(employmentSchema, { ...EMPLEO_VALIDO, positionTitle: '' });
  falla(employmentSchema, { ...EMPLEO_VALIDO, startDate: '01/15/2020' });
});

// --- ingresos -------------------------------------------------------------

const INGRESO_VALIDO = {
  grossPayPerPeriod: 1200,
  incomeFrequency: 'Biweekly',
  netPay1: 1200,
  netPay2: 1200,
  netPay3: 1150,
  netPay4: 1250,
  businessOwnerOrSelfEmployed: false,
  retiredOrPensioner: false,
  paysChildSupport: false,
};

test('incomeSchema acepta el payload completo', () => {
  const r = ok(incomeSchema, INGRESO_VALIDO);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
});

test('incomeSchema valida la frecuencia contra el enum del legacy', () => {
  falla(incomeSchema, { ...INGRESO_VALIDO, incomeFrequency: 'Monthly' });
  falla(incomeSchema, { ...INGRESO_VALIDO, incomeFrequency: 'Anual' });
});

test('incomeSchema rechaza montos negativos o no numericos', () => {
  falla(incomeSchema, { ...INGRESO_VALIDO, netPay1: -100 });
  falla(incomeSchema, { ...INGRESO_VALIDO, grossPayPerPeriod: 'mucho' });
  falla(incomeSchema, { ...INGRESO_VALIDO, grossPayPerPeriod: -1 });
});

test('incomeSchema ya no acepta el mensual calculado por el cliente', () => {
  // El legacy guardaba `totalIncome` tal cual venia del navegador. Ahora ese
  // campo no forma parte del contrato: lo calcula el backend.
  const r = ok(incomeSchema, { ...INGRESO_VALIDO, totalIncome: 999999 });
  assert.equal(r.success, true);
  assert.equal(r.data.totalIncome, undefined);
  assert.equal(r.data.monthlyIncome, undefined);
});

test('incomeSchema exige frecuencia salvo que sea pensionado', () => {
  const sinFrecuencia = { ...INGRESO_VALIDO };
  delete sinFrecuencia.incomeFrequency;
  falla(incomeSchema, sinFrecuencia);
  assert.equal(
    ok(incomeSchema, { ...sinFrecuencia, retiredOrPensioner: true }).success,
    true
  );
});

test('incomeSchema exige el monto si declara pension alimentaria', () => {
  const r = falla(incomeSchema, { ...INGRESO_VALIDO, paysChildSupport: true });
  assert.ok(r.error.issues.some((i) => i.path.includes('childSupportAmount')));
  assert.equal(
    ok(incomeSchema, { ...INGRESO_VALIDO, paysChildSupport: true, childSupportAmount: 400 })
      .success,
    true
  );
});

// --- co-deudor ------------------------------------------------------------

test('coborrowerSchema valida como el borrower principal', () => {
  const valido = {
    firstName: 'Ana',
    lastName: 'Rivera',
    email: 'ana@example.com',
    phone: '(787) 555-1212',
    dob: '1990-03-02',
  };
  const r = ok(coborrowerSchema, valido);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  assert.equal(r.data.phone, '7875551212');
  falla(coborrowerSchema, { ...valido, email: 'ana@' });
});

// --- registro de esquemas -------------------------------------------------

test('stepSchemas cubre cada paso que recibe datos del cliente', () => {
  for (const paso of [
    'start',
    'otpVerify',
    'personal',
    'currentAddress',
    'mailingAddress',
    'employment',
    'income',
    'coborrower',
  ]) {
    assert.ok(stepSchemas[paso], `falta el esquema de ${paso}`);
    assert.equal(typeof stepSchemas[paso].safeParse, 'function');
  }
});

test('ningun esquema deja pasar un payload vacio', () => {
  for (const [paso, schema] of Object.entries(stepSchemas)) {
    assert.equal(schema.safeParse({}).success, false, `${paso} acepto {}`);
  }
});
