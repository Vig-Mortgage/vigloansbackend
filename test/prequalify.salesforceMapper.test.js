'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mapper = require('../lib/prequalify/salesforceMapper');

/**
 * Los valores esperados salen de los `accion*.php` del Joomla legacy, no de lo
 * que "deberia" ser: el objetivo es que un lead creado por la API nueva sea
 * indistinguible de uno creado por el PHP, salvo en las tres cosas que se
 * arreglan a proposito (dedupe, SOQL escapado, SSN que no vuelve).
 */

const LEAD_ID = '00Q1t000001AbCdEAK'; // 18 caracteres, formato real de Lead
const LEAD_ID_15 = '00Q1t000001AbCd';

// ---------------------------------------------------------------------------
// SOQL: escapado
// ---------------------------------------------------------------------------

test('escapeSoqlString escapa la comilla simple', () => {
  assert.equal(mapper.escapeSoqlString("o'brien"), "o\\'brien");
});

test('escapeSoqlString escapa la barra invertida sin duplicar el escape', () => {
  // El bug clasico: escapar la comilla primero y luego la barra convierte
  // \' en \\' y rompe el literal. Un solo paso evita eso.
  assert.equal(mapper.escapeSoqlString("a\\'b"), "a\\\\\\'b");
  assert.equal(mapper.escapeSoqlString('c:\\temp'), 'c:\\\\temp');
});

test('escapeSoqlString escapa comilla doble y blancos reservados', () => {
  assert.equal(mapper.escapeSoqlString('di "hola"'), 'di \\"hola\\"');
  assert.equal(mapper.escapeSoqlString('a\nb'), 'a\\nb');
  assert.equal(mapper.escapeSoqlString('a\rb'), 'a\\rb');
  assert.equal(mapper.escapeSoqlString('a\tb'), 'a\\tb');
  assert.equal(mapper.escapeSoqlString('a\bb'), 'a\\bb');
  assert.equal(mapper.escapeSoqlString('a\fb'), 'a\\fb');
});

test('escapeSoqlString deja intacto lo que no es reservado', () => {
  const raw = "jose.maria+etiqueta_1@vigpr.com";
  assert.equal(mapper.escapeSoqlString(raw), raw);
  // Los comodines de LIKE no son especiales en una comparacion con `=`.
  assert.equal(mapper.escapeSoqlString('100% _seguro'), '100% _seguro');
});

test('escapeSoqlString rechaza controles sin secuencia de escape', () => {
  assert.throws(() => mapper.escapeSoqlString('a\u0000b'), RangeError);
  assert.throws(() => mapper.escapeSoqlString('a\u001fb'), RangeError);
  assert.throws(() => mapper.escapeSoqlString('a\u007fb'), RangeError);
});

test('escapeSoqlString rechaza lo que no es cadena y lo desmesurado', () => {
  for (const valor of [null, undefined, 42, {}, ['a']]) {
    assert.throws(() => mapper.escapeSoqlString(valor), TypeError, String(valor));
  }
  assert.throws(() => mapper.escapeSoqlString('x'.repeat(4097)), RangeError);
});

test('soqlLiteral envuelve en comillas simples ya escapado', () => {
  assert.equal(mapper.soqlLiteral("o'brien"), "'o\\'brien'");
});

// ---------------------------------------------------------------------------
// SOQL: consultas
// ---------------------------------------------------------------------------

test('el dedupe consulta por email y por las variantes de telefono', () => {
  const soql = mapper.buildFindLeadByEmailOrPhoneQuery({
    email: 'Ana@Vigpr.com',
    phone: '(787) 555-1234',
  });
  assert.equal(
    soql,
    "SELECT Id, Tipo_Prestamo__c FROM Lead WHERE Email = 'ana@vigpr.com' " +
      "OR Phone IN ('+17875551234', '7875551234', '17875551234') LIMIT 1"
  );
});

test('el dedupe acepta solo email o solo telefono', () => {
  assert.match(
    mapper.buildFindLeadByEmailOrPhoneQuery({ email: 'a@b.com' }),
    /WHERE Email = 'a@b\.com' LIMIT 1$/
  );
  assert.match(
    mapper.buildFindLeadByEmailOrPhoneQuery({ phone: '7875551234' }),
    /WHERE Phone IN \('\+17875551234', '7875551234', '17875551234'\) LIMIT 1$/
  );
});

test('el dedupe exige al menos un criterio', () => {
  // `accionQuerySalesforce.php:10-12` ya lo exigia; sin esto el WHERE compara
  // contra literales vacios y hace match con cualquier lead en blanco.
  assert.throws(() => mapper.buildFindLeadByEmailOrPhoneQuery({}), RangeError);
  assert.throws(() => mapper.buildFindLeadByEmailOrPhoneQuery(), RangeError);
  assert.throws(
    () => mapper.buildFindLeadByEmailOrPhoneQuery({ email: '   ', phone: '' }),
    RangeError
  );
});

test('la inyeccion SOQL clasica queda neutralizada', () => {
  // El legacy montaba "... WHERE Email = '$email' ..." (accionCrearLead.php:13).
  // Con este payload el WHERE original devolvia el primer lead de la org.
  const soql = mapper.buildFindLeadByEmailOrPhoneQuery({
    email: "x' OR Id != null OR Email = 'y",
  });
  // El payload va escapado y ademas en minusculas (normalizacion del criterio),
  // asi que ni siquiera queda como SOQL valido si alguien lo desescapara.
  assert.equal(
    soql,
    "SELECT Id, Tipo_Prestamo__c FROM Lead WHERE Email = " +
      "'x\\' or id != null or email = \\'y' LIMIT 1"
  );
  // La consulta sigue teniendo exactamente dos comillas sin escapar: las que
  // abren y cierran el unico literal.
  const sinEscapar = soql.match(/(^|[^\\])'/g) ?? [];
  assert.equal(sinEscapar.length, 2);
});

test('caracteres raros en el email no rompen el literal', () => {
  const soql = mapper.buildFindLeadByEmailOrPhoneQuery({
    email: "raro\\'\"\n\t@vigpr.com",
  });
  assert.ok(soql.includes("'raro\\\\\\'\\\"\\n\\t@vigpr.com'"));
  assert.ok(!soql.includes('\n'));
});

test('buildGetLeadQuery no selecciona nunca el SSN', () => {
  const soql = mapper.buildGetLeadQuery(LEAD_ID);
  for (const campo of mapper.SENSITIVE_LEAD_FIELDS) {
    assert.ok(!soql.includes(campo), `${campo} no debe aparecer en la lectura`);
  }
  assert.ok(soql.includes('SELECT Id, Email, Phone'));
  assert.ok(soql.endsWith(`WHERE Id = '${LEAD_ID}' LIMIT 1`));
});

test('buildGetLeadQuery rechaza cualquier cosa que no sea un Id', () => {
  for (const id of ["00Q' OR Id != null", '', 'corto', null, 42]) {
    assert.throws(() => mapper.buildGetLeadQuery(id), RangeError, String(id));
  }
  assert.equal(mapper.isSalesforceId(LEAD_ID_15), true);
  assert.equal(mapper.isSalesforceId(LEAD_ID), true);
});

// ---------------------------------------------------------------------------
// Dedupe: criterio
// ---------------------------------------------------------------------------

test('buildDedupeCriteria normaliza email y telefono', () => {
  assert.deepEqual(
    mapper.buildDedupeCriteria({ email: '  ANA@VIGPR.com ', phone: '+1 (787) 555-1234' }),
    {
      email: 'ana@vigpr.com',
      phone: '7875551234',
      phoneVariants: ['+17875551234', '7875551234', '17875551234'],
    }
  );
});

test('buildDedupeCriteria rechaza un telefono que no son 10 digitos', () => {
  assert.throws(() => mapper.buildDedupeCriteria({ phone: '555' }), RangeError);
});

test('phoneVariants cubre el E.164 que guardaba el legacy', () => {
  // intl-tel-input mandaba `iti.getNumber()` (js/scripts.js:2441-2442), o sea
  // E.164. Sin esta variante el dedupe no encontraria ni un lead historico.
  assert.deepEqual(mapper.phoneVariants('7875551234'), [
    '+17875551234',
    '7875551234',
    '17875551234',
  ]);
  assert.throws(() => mapper.phoneVariants('787555123'), RangeError);
});

// ---------------------------------------------------------------------------
// toLeadFields: paso `start`
// ---------------------------------------------------------------------------

test('start mapea los campos de accionCrearLead.php:248-261', () => {
  const fields = mapper.toLeadFields({
    email: 'ana@vigpr.com',
    phone: '7875551234',
    firstName: 'Ana Maria',
    lastName: 'Diaz',
    dob: '1980-03-15',
    loanPurpose: 'Compra',
    leadSource: 'Landing',
    referredBy: 'juan perez',
    originator: 'VIG-01',
    currentStep: 'personal',
  });

  assert.deepEqual(fields, {
    Email: 'ana@vigpr.com',
    Phone: '+17875551234',
    FirstName: 'ANA MARIA', // strtoupper, accionCrearLead.php:56
    LastName: 'DIAZ', // strtoupper, accionCrearLead.php:57
    Birthdate__c: '1980-03-15',
    Tipo_Prestamo__c: 'Compra', // sin strtoupper en el legacy
    LeadSource: 'Landing', // sin strtoupper
    Referred_By__c: 'JUAN PEREZ', // strtoupper, accionCrearLead.php:66
    Originador__c: 'VIG-01', // sin strtoupper
    currentStep__c: '1',
  });
});

test('los campos ausentes no se envian (un PATCH con "" borraria el dato)', () => {
  const fields = mapper.toLeadFields({ email: 'ana@vigpr.com' });
  assert.deepEqual(fields, { Email: 'ana@vigpr.com' });
  assert.ok(!('Referred_By__c' in fields));
  assert.ok(!('LeadSource' in fields));
  assert.ok(!('currentStep__c' in fields));
});

test('toLeadFields sin argumentos devuelve un patch vacio', () => {
  assert.deepEqual(mapper.toLeadFields(), {});
  assert.deepEqual(mapper.toLeadFields({}), {});
});

// ---------------------------------------------------------------------------
// toLeadFields: paso `personal` + direccion actual
// ---------------------------------------------------------------------------

test('personal mapea el SSN a LASERCA__SSN__c y pone en mayusculas lo que el legacy ponia', () => {
  const fields = mapper.toLeadFields({
    ssn: '123456789',
    citizenship: 'U.S. Citizen',
    maritalStatus: 'Married',
    typeOfCredit: 'CoborrowerCredit',
    dependents: 2,
    coborrowerEmail: 'co@vigpr.com',
    coborrowerPhone: '7875559999',
  });

  assert.deepEqual(fields, {
    LASERCA__SSN__c: '123456789', // accionSalesforce.php:312
    Citizenship__c: 'U.S. CITIZEN', // strtoupper, :69
    Marital_Status__c: 'MARRIED', // strtoupper, :73
    Type_of_Credit__c: 'COBORROWERCREDIT', // strtoupper, :71
    Dependents__c: 2,
    Email_Coborrower__c: 'co@vigpr.com',
    Phone_Coborrower__c: '+17875559999',
  });
});

test('la direccion actual cae en los campos estandar del Lead', () => {
  const fields = mapper.toLeadFields({
    currentAddress: {
      line1: 'Calle Luna 12',
      unit: 'Apt 3', // sin campo en el legacy: se descarta (ver TODO)
      city: 'Ponce',
      state: 'PR',
      zipCode: '00731',
      housing: 'Rent',
      rentMonth: 850,
      years: 1,
      months: 6,
    },
    currentStep: 'currentAddress',
  });

  assert.deepEqual(fields, {
    Street: 'CALLE LUNA 12', // strtoupper, accionSalesforce.php:64
    City: 'Ponce',
    State: 'PR',
    PostalCode: '00731',
    Housing1__c: 'RENT', // strtoupper, :98
    rentMonth__c: 850,
    yearsCurrentAddress__c: 1,
    monthsCurrentAddress__c: 6,
    currentStep__c: '2',
  });
  assert.ok(!('unit' in fields));
});

test('la direccion anterior NO se mapea: Salesforce no tiene donde guardarla', () => {
  // Verificado contra la org de produccion el 2026-08-07: el Lead no tiene
  // `street2__c`, `unit2__c`, `cbocity2__c`, `cbostate2__c` ni `zip2__c`.
  // Se habian portado de `accionDireccionAnterior.php`, que es codigo muerto en
  // el legacy (su POST esta comentado), asi que nunca se ejecutaron contra
  // Salesforce y nadie descubrio que los campos no existian.
  //
  // Este test es un candado: si alguien vuelve a mapearlos sin haberlos creado
  // primero en Salesforce, la primera solicitud real fallaria con INVALID_FIELD.
  const fields = mapper.toLeadFields({
    previousAddress: {
      line1: 'Calle Sol 4',
      unit: 'B',
      city: 'Caguas',
      state: 'PR',
      zipCode: '00725',
      housing: 'Own',
      rentMonth: 0,
      years: 3,
      months: 0,
    },
  });

  assert.deepEqual(fields, {}, 'la direccion anterior no debe producir ningun campo');
  for (const inexistente of ['street2__c', 'unit2__c', 'cbocity2__c', 'cbostate2__c', 'zip2__c']) {
    assert.ok(!(inexistente in fields), `${inexistente} no existe en Salesforce`);
  }
});

test('el lead del co-deudor lleva Coborrower__c y el enlace al deudor', () => {
  const fields = mapper.toLeadFields({
    email: 'co@vigpr.com',
    firstName: 'Luis',
    lastName: 'Rivera',
    isCoborrower: true,
    borrowerLeadId: LEAD_ID,
    currentStep: 'personal',
  });

  assert.equal(fields.Coborrower__c, true); // accionCrearLeadCoBorrower.php:261
  assert.equal(fields.Borrower__c, LEAD_ID); // :260
  assert.equal(fields.currentStep__c, '1'); // :262
});

test('el enlace inverso se escribe sobre el lead del deudor', () => {
  assert.deepEqual(mapper.toCoborrowerBackLinkFields(LEAD_ID), {
    Coborrower_Lead__c: LEAD_ID,
  });
  assert.throws(() => mapper.toCoborrowerBackLinkFields('no-es-id'), RangeError);
});

test('el resultado de calificacion va a DTI__c, Housing__c y Cantidad__c', () => {
  const fields = mapper.toLeadFields({
    qualification: { dti: 41.2345, housingRatio: 28.5, maxHomePrice: 0 },
  });
  // accionIncome.php:260-262
  assert.deepEqual(fields, { DTI__c: 41.2345, Housing__c: 28.5, Cantidad__c: 0 });
});

// ---------------------------------------------------------------------------
// currentStep__c
// ---------------------------------------------------------------------------

test('currentStep__c usa la numeracion legacy y es cadena', () => {
  assert.deepEqual(mapper.toCurrentStepFields('personal'), { currentStep__c: '1' });
  assert.deepEqual(mapper.toCurrentStepFields('currentAddress'), { currentStep__c: '2' });
  assert.deepEqual(mapper.toCurrentStepFields('employment'), { currentStep__c: '3' });
  assert.deepEqual(mapper.toCurrentStepFields('income'), { currentStep__c: '4' });
  assert.deepEqual(mapper.toCurrentStepFields('submit'), { currentStep__c: '5' });
});

test('los pasos que el legacy no numera no tocan currentStep__c', () => {
  for (const paso of ['start', 'otpVerify', 'previousAddress', 'mailingAddress', 'coborrower', 'done']) {
    assert.deepEqual(mapper.toCurrentStepFields(paso), {}, paso);
  }
  assert.deepEqual(mapper.toCurrentStepFields(undefined), {});
  assert.deepEqual(mapper.toCurrentStepFields(null), {});
});

// ---------------------------------------------------------------------------
// Objetos hijos
// ---------------------------------------------------------------------------

test('la direccion postal crea un MailingAddress__c colgado del lead', () => {
  const record = mapper.toMailingAddressRecord(LEAD_ID, {
    line1: 'PO Box 100',
    unit: '',
    city: 'San Juan',
    state: 'PR',
    zipCode: '00901',
    // housing/years/months existen en el esquema pero el legacy no los guarda
    housing: 'Rent',
    years: 2,
    months: 0,
  });

  // accionMailingAddress.php:224-232
  assert.deepEqual(record, {
    Lead__c: LEAD_ID,
    StreetMailAddress__c: 'PO Box 100',
    cbocityMailAddress__c: 'San Juan',
    cbostateMailAddress__c: 'PR',
    ZIPMailAddress__c: '00901',
  });
  assert.equal(mapper.SObject.MAILING_ADDRESS, 'MailingAddress__c');
});

test('el empleo crea un Employment_SelfEmployment__c con las mayusculas del legacy', () => {
  const record = mapper.toEmploymentRecord(LEAD_ID, {
    employerBusinessName: 'Farmacia Luna',
    positionTitle: 'gerente',
    startDate: '2019-05-01',
    employerPhone: '7875550000',
    employedByFamily: false,
    line1: 'Ave Ponce 55',
    unit: '2',
    city: 'Ponce',
    state: 'PR',
    zipCode: '00716',
    yearsEmployment: 6,
    monthsEmployment: 2,
  });

  // accionEmployment_SelfEmployment.php:284-299
  assert.deepEqual(record, {
    Lead__c: LEAD_ID,
    EmployerBusinessName__c: 'FARMACIA LUNA', // strtoupper, :191
    StreetEmployer__c: 'AVE PONCE 55', // strtoupper, :228
    PositionTitle__c: 'GERENTE', // strtoupper, :244
    PhoneEmployer__c: '+17875550000',
    cbostateEmployer__c: 'PR',
    cbocityEmployer__c: 'Ponce', // el legacy no la pone en mayusculas
    ZIPEmployer__c: '00716',
    UnitEmployer__c: '2',
    StartDate__c: '2019-05-01',
    yearsEmployment__c: 6,
    monthsEmployment__c: 2,
    Employer_Family__c: '',
  });
});

test('Employer_Family__c guarda la frase literal del checkbox, no un booleano', () => {
  const record = mapper.toEmploymentRecord(LEAD_ID, { employedByFamily: true });
  // index.php:1321 -> accionEmployment_SelfEmployment.php:297
  assert.equal(record.Employer_Family__c, mapper.EMPLOYER_FAMILY_LEGACY_VALUE);
  assert.match(record.Employer_Family__c, /^family member, property seller/);
});

test('los objetos hijos exigen un Id de lead valido', () => {
  assert.throws(() => mapper.toMailingAddressRecord('x', {}), RangeError);
  assert.throws(() => mapper.toEmploymentRecord('x', {}), RangeError);
  assert.throws(() => mapper.toIncomeRecord('x', {}), RangeError);
});

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

const INGRESO_BASE = {
  grossPayPerPeriod: 1200,
  monthlyIncome: 2600,
  incomeFrequency: 'Biweekly',
  netPay1: 900,
  netPay2: 910,
  netPay3: 920,
  netPay4: 930,
  paysChildSupport: true,
  childSupportAmount: 150,
  businessOwnerOrSelfEmployed: false,
  retiredOrPensioner: false,
};

test('income: la rama de empleado usa paystubFile/netincome', () => {
  const record = mapper.toIncomeRecord(LEAD_ID, INGRESO_BASE, ['f1', 'f2', 'f3', 'f4']);

  // accionIncome.php:144-162
  assert.equal(record.Lead__c, LEAD_ID);
  assert.equal(record.BussinessOwnerOrSelfEmployed__c, 'EMPLOYED');
  assert.deepEqual(
    {
      p1: record.paystubFile1__c,
      p2: record.paystubFile2__c,
      p3: record.paystubFile3__c,
      p4: record.paystubFile4__c,
    },
    { p1: 'f1', p2: 'f2', p3: 'f3', p4: 'f4' }
  );
  assert.equal(record.netincome1__c, 900);
  assert.equal(record.netincome4__c, 930);
  assert.ok(!('taxesFile1__c' in record));
  assert.ok(!('formaFile__c' in record));
});

test('income: MonthlyIncome__c guarda el pago por periodo y TotalIncome__c el mensual', () => {
  // Los nombres estan invertidos en la org desde el legacy
  // (js/scripts.js:589-604 + accionIncome.php:149,153). Se respetan.
  const record = mapper.toIncomeRecord(LEAD_ID, INGRESO_BASE);
  assert.equal(record.MonthlyIncome__c, 1200);
  assert.equal(record.TotalIncome__c, 2600);
  assert.equal(record.IncomeFrequency__c, 'Biweekly');
});

test('income: la pension alimentaria es YES/NO en mayusculas', () => {
  const si = mapper.toIncomeRecord(LEAD_ID, INGRESO_BASE);
  assert.equal(si.DoYouPayforChildSupport__c, 'YES'); // accionIncome.php:128,137
  assert.equal(si.HowMuchChildSupport__c, 150);

  const no = mapper.toIncomeRecord(LEAD_ID, {
    ...INGRESO_BASE,
    paysChildSupport: false,
    childSupportAmount: undefined,
  });
  assert.equal(no.DoYouPayforChildSupport__c, 'NO');
  assert.ok(!('HowMuchChildSupport__c' in no));
});

test('income: la rama de retirado usa formaFile/formaTotal', () => {
  const record = mapper.toIncomeRecord(
    LEAD_ID,
    { ...INGRESO_BASE, retiredOrPensioner: true, incomeFrequency: undefined },
    ['f1', 'f2']
  );
  // accionIncome.php:131-143
  assert.equal(record.BussinessOwnerOrSelfEmployed__c, 'RETIRED OR PENSIONER');
  assert.equal(record.formaFile__c, 'f1');
  assert.equal(record.formaTotal__c, 900);
  assert.ok(!('paystubFile1__c' in record));
  assert.ok(!('IncomeFrequency__c' in record));
});

test('income: la rama de self-employed usa taxesFile 1..4 y solo taxesTotal 1..3', () => {
  const record = mapper.toIncomeRecord(
    LEAD_ID,
    { ...INGRESO_BASE, businessOwnerOrSelfEmployed: true },
    ['f1', 'f2', 'f3', 'f4']
  );
  // accionIncome.php:163-180
  assert.equal(record.BussinessOwnerOrSelfEmployed__c, 'SELF-EMPLOYED');
  assert.equal(record.taxesFile4__c, 'f4');
  assert.equal(record.taxesTotal3__c, 920);
  // El legacy no escribe un cuarto total en esta rama (ver TODO(Roberto)).
  assert.ok(!('taxesTotal4__c' in record));
});

test('income: nunca se escribe RetiredorPensioner__c sin saber su picklist', () => {
  for (const extra of [{}, { retiredOrPensioner: true }, { businessOwnerOrSelfEmployed: true }]) {
    const record = mapper.toIncomeRecord(LEAD_ID, { ...INGRESO_BASE, ...extra });
    assert.ok(
      !('RetiredorPensioner__c' in record),
      'el enum de fuente de pension todavia no existe en la API'
    );
  }
});

test('toEmploymentKind prioriza retirado sobre self-employed', () => {
  const { EmploymentKind } = mapper;
  assert.equal(mapper.toEmploymentKind({}), EmploymentKind.EMPLOYED);
  assert.equal(
    mapper.toEmploymentKind({ businessOwnerOrSelfEmployed: true }),
    EmploymentKind.SELF_EMPLOYED
  );
  assert.equal(
    mapper.toEmploymentKind({ retiredOrPensioner: true }),
    EmploymentKind.RETIRED_OR_PENSIONER
  );
  // Los dos booleanos a la vez es un estado que el radio legacy no permite.
  assert.equal(
    mapper.toEmploymentKind({ businessOwnerOrSelfEmployed: true, retiredOrPensioner: true }),
    EmploymentKind.RETIRED_OR_PENSIONER
  );
});

// ---------------------------------------------------------------------------
// fromLeadRecord
// ---------------------------------------------------------------------------

const REGISTRO_SF = Object.freeze({
  attributes: { type: 'Lead', url: '/services/data/v52.0/sobjects/Lead/x' },
  Id: LEAD_ID,
  Email: 'ana@vigpr.com',
  Phone: '+17875551234',
  FirstName: 'ANA',
  LastName: 'DIAZ',
  Birthdate__c: '1980-03-15',
  currentStep__c: '2',
  Email_Coborrower__c: 'co@vigpr.com',
  Phone_Coborrower__c: '+17875559999',
  Street: 'CALLE LUNA 12',
  City: 'Ponce',
  State: 'PR',
  PostalCode: '00731',
  Citizenship__c: 'U.S. CITIZEN',
  Type_of_Credit__c: 'COBORROWERCREDIT',
  Marital_Status__c: 'MARRIED',
  Dependents__c: 2,
  yearsCurrentAddress__c: 1,
  monthsCurrentAddress__c: 6,
  Housing1__c: 'RENT',
  rentMonth__c: 850,
});

test('fromLeadRecord NUNCA devuelve el SSN, aunque venga en el registro', () => {
  // Esto es lo que hacia mal `accionQueryAllData.php`: seleccionaba
  // LASERCA__SSN__c (:9) y volcaba todos los campos a la respuesta (:131-146).
  const lead = mapper.fromLeadRecord({
    ...REGISTRO_SF,
    LASERCA__SSN__c: '123456789',
    Alguna_Cosa_Nueva__c: 'valor inesperado',
  });

  const serializado = JSON.stringify(lead);
  assert.ok(!serializado.includes('123456789'), 'el SSN se filtro en la lectura');
  assert.ok(!serializado.includes('LASERCA'));
  assert.ok(!('ssn' in lead));
  // Lista blanca: un campo nuevo en la org tampoco se cuela solo.
  assert.ok(!serializado.includes('valor inesperado'));
});

test('fromLeadRecord devuelve el modelo camelCase de la API', () => {
  assert.deepEqual(mapper.fromLeadRecord(REGISTRO_SF), {
    id: LEAD_ID,
    email: 'ana@vigpr.com',
    phone: '7875551234',
    firstName: 'ANA',
    lastName: 'DIAZ',
    dob: '1980-03-15',
    coborrowerEmail: 'co@vigpr.com',
    coborrowerPhone: '7875559999',
    citizenship: 'U.S. Citizen',
    maritalStatus: 'Married',
    typeOfCredit: 'CoborrowerCredit',
    dependents: 2,
    currentAddress: {
      line1: 'CALLE LUNA 12',
      city: 'Ponce',
      state: 'PR',
      zipCode: '00731',
      housing: 'Rent',
      rentMonth: 850,
      years: 1,
      months: 6,
    },
    legacyStep: 2,
    currentStep: 'currentAddress',
    // Derivado, no leido: Salesforce no tiene campo para la lista.
    //
    // `currentAddress` entra aunque `currentStep__c` sea 2 (o sea, "reanuda EN
    // currentAddress"), porque este registro trae la direccion completa
    // escrita. Es la via de EVIDENCIA: si los datos del paso estan en el Lead,
    // el paso se hizo. Sin ella, completar la direccion no se podia registrar
    // —el paso siguiente, `creditCheck`, no tiene numero legacy— y el wizard
    // retrocedia al formulario vacio.
    completedSteps: ['start', 'otpVerify', 'personal', 'currentAddress'],
  });
});

test('fromLeadRecord traduce currentStep__c con la maquina de estados', () => {
  for (const [legacy, paso] of [
    ['1', 'personal'],
    ['2', 'currentAddress'],
    ['3', 'employment'],
    ['4', 'income'],
    ['5', 'submit'],
  ]) {
    const lead = mapper.fromLeadRecord({ Id: LEAD_ID, currentStep__c: legacy });
    assert.equal(lead.currentStep, paso, legacy);
    assert.equal(lead.legacyStep, Number(legacy));
  }
  // Un valor fuera de la tabla no inventa un paso, pero conserva el numero.
  const raro = mapper.fromLeadRecord({ Id: LEAD_ID, currentStep__c: '9' });
  assert.ok(!('currentStep' in raro));
  assert.equal(raro.legacyStep, 9);
});

test('fromLeadRecord conserva valores de picklist que no reconoce', () => {
  const lead = mapper.fromLeadRecord({ Id: LEAD_ID, Housing1__c: 'VIVE CON FAMILIA' });
  assert.equal(lead.currentAddress.housing, 'VIVE CON FAMILIA');
});

test('fromLeadRecord omite lo vacio en vez de devolver nulls', () => {
  const lead = mapper.fromLeadRecord({ Id: LEAD_ID, Email: null, Street: '   ' });
  assert.deepEqual(lead, { id: LEAD_ID });
  assert.ok(!('currentAddress' in lead));
});

test('fromLeadRecord con registro ausente devuelve null', () => {
  assert.equal(mapper.fromLeadRecord(null), null);
  assert.equal(mapper.fromLeadRecord(undefined), null);
  assert.throws(() => mapper.fromLeadRecord('no soy un registro'), TypeError);
  assert.throws(() => mapper.fromLeadRecord([REGISTRO_SF]), TypeError);
});

// ---------------------------------------------------------------------------
// Coherencia del modulo
// ---------------------------------------------------------------------------

test('la lista de lectura no contiene ningun campo sensible', () => {
  for (const campo of mapper.SENSITIVE_LEAD_FIELDS) {
    assert.ok(!mapper.LEAD_READ_FIELDS.includes(campo), campo);
  }
});

test('cada entrada del mapeo cita su origen en el legacy', () => {
  for (const entrada of mapper.LEAD_FIELD_MAP) {
    assert.match(
      entrada.cite,
      /^accion[A-Za-z_]+\.php:[\d,]+$/,
      `${entrada.path} debe citar archivo:linea`
    );
  }
});

test('ningun campo de Salesforce esta mapeado dos veces', () => {
  const campos = mapper.LEAD_FIELD_MAP.map((entrada) => entrada.sf);
  assert.equal(new Set(campos).size, campos.length);
});

// --- completedSteps derivado ---------------------------------------------

test('completedSteps se deriva de currentStep__c porque Salesforce no lo guarda', () => {
  // No existe ningun campo donde persistir la lista (verificado contra
  // produccion el 2026-08-07) y no hay acceso de admin para crearlo. Se deriva:
  // si el lead va por el paso N, los aplicables anteriores estan hechos.
  const paso3 = mapper.fromLeadRecord({ Id: '00Q1', LastName: 'X', currentStep__c: '3' });
  assert.deepEqual(paso3.completedSteps, [
    'start', 'otpVerify', 'personal', 'currentAddress', 'creditCheck',
  ]);
  assert.equal(paso3.currentStep, 'employment');
});

test('completedSteps crece de forma monotona con currentStep__c', () => {
  let anterior = 0;
  for (const n of ['1', '2', '3', '4', '5']) {
    const r = mapper.fromLeadRecord({ Id: '00Q1', LastName: 'X', currentStep__c: n });
    assert.ok(
      r.completedSteps.length > anterior,
      `currentStep__c=${n} deberia completar mas pasos que el anterior`
    );
    anterior = r.completedSteps.length;
  }
});

test('sin currentStep__c no se inventan pasos completados', () => {
  const r = mapper.fromLeadRecord({ Id: '00Q1', LastName: 'X' });
  assert.equal(r.completedSteps, undefined);
});
