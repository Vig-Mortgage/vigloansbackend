'use strict';

/**
 * Reporte de credito de Experian **sintetico**, solo para tests.
 *
 * Todo el contenido es inventado. Los nombres son obviamente ficticios
 * ("PRUEBA FICTICIA", "NO EXISTE"), las direcciones son de ejemplo y los
 * acreedores se llaman "BANCO DE PRUEBA". No hay ni puede haber datos de una
 * persona real aqui: si alguien necesita reproducir un caso de produccion, se
 * hace contra el ambiente de Experian, nunca copiando un reporte al repo.
 *
 * **No incluye SSN.** El parser (`lib/prequalify/experian.js`) no extrae SSN de
 * ninguna seccion, asi que el fixture tampoco lo trae: lo que no existe en el
 * repo no se puede filtrar.
 *
 * La forma imita la respuesta real: `{ creditProfile: [ { <seccion>: [...] } ] }`
 * segun el despacho de `vigpr-joomla/prequalify/accionExperian.php:1927-2004`.
 *
 * Cifras pensadas para que los tests sean verificables a mano:
 *   - score AF = "0705"  -> 705
 *   - pagos mensuales: 350 + 125.50 + 24.25 = 499.75
 *     (los tradelines con `UNKNOWN` y sin `monthlyPaymentAmount` no suman)
 */

const SAMPLE_CREDIT_REPORT = {
  creditProfile: [
    {
      riskModel: [
        // Modelo que NO es 'AF': debe ignorarse (accionExperian.php:969).
        { modelIndicator: 'V4', score: '0999', evaluation: 'P' },
        { modelIndicator: 'AF', score: '0705', evaluation: 'P', scorePercentile: '55' },
      ],

      tradeline: [
        {
          subscriberName: 'BANCO DE PRUEBA UNO',
          originalCreditorName: 'BANCO DE PRUEBA UNO',
          accountType: '18',
          revolvingOrInstallment: 'I',
          openOrClosed: 'O',
          ecoa: '1',
          balanceAmount: '12500',
          monthlyPaymentAmount: '350',
          amountPastDue: 'UNKNOWN',
          amount1: '20000',
          amount1Qualifier: 'O',
          amount2: 'UNKNOWN',
          openDate: '03152019',
          statusDate: '01102026',
          status: '11',
          terms: '060',
          monthsHistory: '48',
          derogCounter: '0',
          delinquencies30Days: '0',
          delinquencies60Days: '0',
          delinquencies90to180Days: '0',
          enhancedPaymentData: {
            enhancedAccountType: '18',
            creditLimitAmount: 'UNKNOWN',
            highBalanceAmount: '20000',
            originalLoanAmount: '20000',
            chargeoffAmount: 'UNKNOWN',
            enhancedPaymentStatus: '11',
          },
        },
        {
          subscriberName: 'TARJETA FICTICIA DOS',
          originalCreditorName: 'TARJETA FICTICIA DOS',
          accountType: '07',
          revolvingOrInstallment: 'R',
          openOrClosed: 'O',
          ecoa: '2',
          balanceAmount: '3200.75',
          monthlyPaymentAmount: '125.50',
          amountPastDue: '0',
          openDate: '07012021',
          status: '11',
          derogCounter: '0',
          delinquencies30Days: '1',
          delinquencies60Days: '0',
          delinquencies90to180Days: '0',
        },
        {
          // Cuenta CERRADA que igual reporta pago mensual: el legacy la suma
          // (accionExperian.php:585 no mira `openOrClosed`).
          subscriberName: 'FINANCIERA IMAGINARIA TRES',
          accountType: '00',
          openOrClosed: 'C',
          balanceAmount: '0',
          monthlyPaymentAmount: '24.25',
          status: '11',
          derogCounter: '0',
        },
        {
          // Derogatoria: no afecta la decision hoy, pero debe aparecer en el
          // resumen de `summarizeDerogatory`.
          subscriberName: 'COBROS FICTICIOS CUATRO',
          accountType: '48',
          openOrClosed: 'O',
          balanceAmount: '1800',
          monthlyPaymentAmount: 'UNKNOWN',
          amountPastDue: '1800',
          bankruptcyChapterNumber: '7',
          derogCounter: '2',
          delinquencies30Days: '2',
          delinquencies60Days: '1',
          delinquencies90to180Days: '3',
          status: '97',
          enhancedPaymentData: {
            chargeoffAmount: '1800',
            enhancedAccountCondition: 'C',
          },
        },
        {
          // Sin `monthlyPaymentAmount`: no suma.
          subscriberName: 'HIPOTECA INVENTADA CINCO',
          accountType: '19',
          openOrClosed: 'C',
          balanceAmount: '0',
          status: '11',
          derogCounter: '0',
        },
      ],

      fraudShield: [
        {
          fraudShieldIndicators: { indicator: ['07', '21', '77'] },
          addressCount: '2',
          socialCount: '1',
          type: 'FS',
        },
      ],

      inquiry: [
        {
          subscriberName: 'CONCESIONARIO DE PRUEBA',
          date: '11052025',
          kob: 'AN',
          type: 'CREDIT',
          amount: '0',
        },
      ],

      addressInformation: [
        {
          streetName: 'CALLE EJEMPLO 123',
          city: 'CIUDAD DE PRUEBA',
          state: 'PR',
          stateCode: '72',
          zipCode: '00000',
          dwellingType: 'S',
          timesReported: '4',
          firstReportedDate: '01012019',
          lastUpdatedDate: '01012026',
        },
      ],

      employmentInformation: [
        {
          name: 'PATRONO FICTICIO SA',
          addressFirstLine: 'AVENIDA IMAGINARIA 1',
          zipCode: '00000',
          source: 'C',
          firstReportedDate: '02012020',
        },
      ],

      consumerIdentity: {
        dob: { day: '01', month: '01', year: '1980' },
        name: [
          {
            firstName: 'PRUEBA',
            middleName: 'FICTICIA',
            surname: 'NOEXISTE',
            type: 'N',
          },
        ],
      },

      statement: [
        {
          dateReported: '06152025',
          statementText: 'DECLARACION DE PRUEBA - CONTENIDO INVENTADO',
          type: 'G',
        },
      ],

      ofac: [{ messageNumber: '000', messageText: 'NO OFAC MATCH - DATO DE PRUEBA' }],

      mla: [{ messageNumber: '001', messageText: 'NO MLA MATCH - DATO DE PRUEBA' }],

      summaries: [
        {
          summaryType: 'Profile Summary',
          attributes: [
            { id: 'totalTradeItems', value: '5' },
            { id: 'inquiriesDuringLast6Months', value: '1' },
          ],
        },
      ],

      // Seccion presente pero cuyo despacho estaba comentado en el legacy
      // (accionExperian.php:1973-1977).
      publicRecord: [
        {
          courtName: 'TRIBUNAL DE PRUEBA',
          amount: '4500',
          status: '02',
          filingDate: '05202018',
          bankruptcyVoluntaryIndicator: 'V',
        },
      ],
    },
  ],
};

/** Reporte sin la seccion `creditProfile`: el legacy lanzaba (`:2009-2011`). */
const EMPTY_CREDIT_REPORT = { errors: [] };

/** Reporte sin ningun `riskModel` con indicador 'AF'. */
const NO_AF_SCORE_REPORT = {
  creditProfile: [
    {
      riskModel: [{ modelIndicator: 'V4', score: '0800' }],
      tradeline: [
        { subscriberName: 'BANCO DE PRUEBA UNO', monthlyPaymentAmount: '100' },
      ],
    },
  ],
};

module.exports = {
  SAMPLE_CREDIT_REPORT,
  EMPTY_CREDIT_REPORT,
  NO_AF_SCORE_REPORT,
};
