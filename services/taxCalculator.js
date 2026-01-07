/**
 * Country-Specific Tax Calculation Service
 * Automatically calculates taxes based on business country and type
 */

/**
 * Calculate taxes for Nigeria (2026 Tax Laws)
 * @param {Object} params - Tax calculation parameters
 * @param {number} params.subtotal - Invoice subtotal
 * @param {string} params.businessType - 'individual' or 'company'
 * @param {number} params.annualTurnover - Annual turnover (for companies)
 * @param {number} params.totalFixedAssets - Total fixed assets (for companies)
 * @returns {Object} Tax breakdown
 */
function calculateNigeriaTax(params) {
  const { subtotal, businessType, annualTurnover, totalFixedAssets } = params;
  
  const taxBreakdown = {
    vat: 0,
    development_levy: 0,
    personal_income_tax: 0,
    corporate_income_tax: 0,
    capital_gains_tax: 0,
    total_tax: 0,
    exemptions: [],
    tax_details: {}
  };

  // For companies
  if (businessType === 'company') {
    // Check if company qualifies for small business exemption
    // Exemption: Turnover ≤ ₦100M AND Fixed Assets ≤ ₦250M
    const isSmallBusiness = 
      annualTurnover && annualTurnover <= 100000000 &&
      totalFixedAssets && totalFixedAssets <= 250000000;

    if (isSmallBusiness) {
      taxBreakdown.exemptions.push('Small Business Exemption (Turnover ≤ ₦100M, Assets ≤ ₦250M)');
      taxBreakdown.tax_details = {
        message: 'Company qualifies for small business tax exemption',
        exemption_reason: 'Annual turnover ≤ ₦100M and total fixed assets ≤ ₦250M',
        applicable_taxes: []
      };
      return taxBreakdown;
    }

    // Development Levy: 4% on assessable profits (applied to invoice subtotal)
    // Note: In practice, this is calculated on profits, but for invoices we apply to subtotal
    taxBreakdown.development_levy = subtotal * 0.04;
    taxBreakdown.tax_details.development_levy_rate = '4%';
    taxBreakdown.tax_details.development_levy_note = 'Replaces Tertiary Education Tax and Police Trust Fund levy';

    // Corporate Income Tax: Typically 30% on profits
    // For invoices, this is usually not applied directly, but noted for reference
    taxBreakdown.tax_details.corporate_income_tax_note = '30% CIT applies to annual profits, not individual invoices';

    // Capital Gains Tax: 30% (applies to asset sales, not regular invoices)
    taxBreakdown.tax_details.capital_gains_tax_note = '30% CGT applies to capital gains, not regular sales';
  }

  // For individuals
  if (businessType === 'individual') {
    // Personal Income Tax: Progressive brackets
    // Note: PIT is calculated on annual income, not individual invoices
    // For invoices, we typically don't apply PIT directly
    taxBreakdown.tax_details.personal_income_tax_note = 'PIT applies to annual income with progressive brackets (0-25%)';
    taxBreakdown.tax_details.pit_brackets = {
      '₦0 - ₦800,000': '0%',
      '₦800,001 - ₦3,000,000': '15%',
      '₦3,000,001 - ₦12,000,000': '18%',
      '₦12,000,001 - ₦25,000,000': '21%',
      '₦25,000,001 - ₦50,000,000': '23%',
      'Above ₦50,000,000': '25%'
    };
  }

  // VAT (Value Added Tax): 7.5% - applies to most goods and services
  // This is the most common tax applied to invoices
  taxBreakdown.vat = subtotal * 0.075;
  taxBreakdown.tax_details.vat_rate = '7.5%';
  taxBreakdown.tax_details.vat_note = 'Standard VAT rate in Nigeria';

  // Calculate total tax
  taxBreakdown.total_tax = 
    taxBreakdown.vat + 
    taxBreakdown.development_levy + 
    taxBreakdown.personal_income_tax + 
    taxBreakdown.corporate_income_tax + 
    taxBreakdown.capital_gains_tax;

  return taxBreakdown;
}

/**
 * Main tax calculation function
 * Automatically selects country-specific tax rules
 * @param {Object} params - Tax calculation parameters
 * @param {string} params.country - Business country (e.g., 'Nigeria')
 * @param {number} params.subtotal - Invoice subtotal
 * @param {string} params.businessType - 'individual' or 'company'
 * @param {number} params.annualTurnover - Annual turnover (for companies)
 * @param {number} params.totalFixedAssets - Total fixed assets (for companies)
 * @returns {Object} Tax breakdown
 */
function calculateTax(params) {
  const { country = 'Nigeria', subtotal, businessType, annualTurnover, totalFixedAssets } = params;

  if (!subtotal || subtotal <= 0) {
    return {
      vat: 0,
      development_levy: 0,
      personal_income_tax: 0,
      corporate_income_tax: 0,
      capital_gains_tax: 0,
      total_tax: 0,
      exemptions: [],
      tax_details: {
        message: 'No tax calculation needed for zero or negative subtotal'
      }
    };
  }

  // Country-specific tax calculation
  switch (country) {
    case 'Nigeria':
      return calculateNigeriaTax({
        subtotal,
        businessType,
        annualTurnover,
        totalFixedAssets
      });

    // Add other countries here as needed
    // case 'Ghana':
    //   return calculateGhanaTax(params);
    // case 'Kenya':
    //   return calculateKenyaTax(params);

    default:
      // Default: No automatic tax calculation
      // User can manually specify tax_rate
      return {
        vat: 0,
        development_levy: 0,
        personal_income_tax: 0,
        corporate_income_tax: 0,
        capital_gains_tax: 0,
        total_tax: 0,
        exemptions: [],
        tax_details: {
          message: `Automatic tax calculation not yet implemented for ${country}. Please specify tax_rate manually.`,
          country: country
        }
      };
  }
}

/**
 * Get tax information for a country (for display/UI purposes)
 * @param {string} country - Country code or name
 * @returns {Object} Tax information
 */
function getTaxInfo(country = 'Nigeria') {
  switch (country) {
    case 'Nigeria':
      return {
        country: 'Nigeria',
        currency: 'NGN',
        vat_rate: 7.5,
        vat_name: 'Value Added Tax (VAT)',
        development_levy_rate: 4,
        development_levy_name: 'Development Levy',
        corporate_income_tax_rate: 30,
        corporate_income_tax_name: 'Companies Income Tax (CIT)',
        capital_gains_tax_rate: 30,
        capital_gains_tax_name: 'Capital Gains Tax (CGT)',
        small_business_exemption: {
          enabled: true,
          turnover_threshold: 100000000, // ₦100M
          fixed_assets_threshold: 250000000, // ₦250M
          exempt_taxes: ['CIT', 'CGT', 'Development Levy']
        },
        personal_income_tax: {
          enabled: true,
          exemption_threshold: 800000, // ₦800,000
          brackets: [
            { min: 0, max: 800000, rate: 0 },
            { min: 800001, max: 3000000, rate: 15 },
            { min: 3000001, max: 12000000, rate: 18 },
            { min: 12000001, max: 25000000, rate: 21 },
            { min: 25000001, max: 50000000, rate: 23 },
            { min: 50000001, max: null, rate: 25 }
          ]
        },
        effective_date: '2026-01-01',
        tax_authority: 'Nigeria Revenue Service (NRS)',
        notes: [
          'Small businesses (turnover ≤ ₦100M, assets ≤ ₦250M) are exempt from CIT, CGT, and Development Levy',
          'Development Levy (4%) replaces Tertiary Education Tax and Police Trust Fund levy',
          'Personal Income Tax applies to annual income with progressive brackets',
          'VAT (7.5%) applies to most goods and services'
        ]
      };

    default:
      return {
        country: country,
        message: 'Tax information not available for this country',
        note: 'Please consult local tax authorities or specify tax rates manually'
      };
  }
}

module.exports = {
  calculateTax,
  calculateNigeriaTax,
  getTaxInfo
};

