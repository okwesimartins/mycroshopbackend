/**
 * Invoice Template Library
 * Pre-designed beautiful invoice templates based on reference images
 * Colors are dynamically applied based on user's logo colors
 */

/**
 * Generate template library options based on brand colors
 * @param {Object} brandColors - Brand color palette extracted from user's logo
 * @returns {Array} Array of template objects
 */
function generateTemplateLibrary(brandColors) {
  // Use brand colors with smart defaults
  const primary = brandColors.primary || '#1E40AF'; // Dark blue default
  const secondary = brandColors.secondary || '#64748B'; // Gray default
  const accent = brandColors.accent || '#F59E0B'; // Golden yellow default
  const text = brandColors.text || '#1F2937'; // Dark gray default
  const background = '#FFFFFF';
  const border = brandColors.border || '#E5E7EB';
  const table_header = brandColors.table_header || primary;
  const table_row_alt = brandColors.table_row_alt || '#F9FAFB';

  const templates = [
    // Template 1: Dark Blue/Purple Geometric (Image 1 - Angular shapes)
    {
      id: 'template_1',
      name: 'Geometric Angular Blue',
      description: 'Dark blue and purple angular geometric shapes with professional layout',
      style: 'geometric_angular_blue',
      tokens: {
        primary: primary,
        secondary: secondary,
        accent: accent,
        text: text,
        background: background,
        border: border,
        table_header: primary,
        table_row_alt: '#F3F4F6',
        font: 'Inter',
        fontSize: '13px',
        headingSize: '32px'
      },
      decorations: [
        {
          asset: 'layered_angular_shapes',
          anchor: 'top-left',
          scale: 1.4,
          rotate: 0,
          colors: { fill: 'primary', opacity: 1.0 }
        },
        {
          asset: 'layered_angular_shapes',
          anchor: 'top-right',
          scale: 1.0,
          rotate: 90,
          colors: { fill: 'secondary', opacity: 0.85 }
        },
        {
          asset: 'layered_angular_shapes',
          anchor: 'bottom-left',
          scale: 1.0,
          rotate: 180,
          colors: { fill: 'secondary', opacity: 0.85 }
        },
        {
          asset: 'layered_angular_shapes',
          anchor: 'bottom-right',
          scale: 1.4,
          rotate: 270,
          colors: { fill: 'primary', opacity: 1.0 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'invoice_title_right_aligned', show_logo: false, show_business_info: false },
        { block: 'CustomerInfo', variant: 'invoice_to_left_total_right', show_label: true },
        { block: 'ItemsTable', variant: 'blue_header', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'blue_total_box_right', show_borders: false },
        { block: 'Payment', variant: 'payment_method_left', show_account_number: true },
        { block: 'Footer', variant: 'minimal', show_terms: false }
      ],
      spacing: { section_gap: '18px', item_gap: '8px', padding: '24px' }
    },

    // Template 2: Yellow and Dark Blue (Image 2 - Vibrant geometric)
    {
      id: 'template_2',
      name: 'Vibrant Yellow Blue',
      description: 'Yellow and dark blue geometric shapes with colorful headers',
      style: 'vibrant_yellow_blue',
      tokens: {
        primary: primary, // Dark blue
        secondary: secondary,
        accent: accent, // Yellow
        text: text,
        background: background,
        border: border,
        table_header: accent, // Yellow for DESCRIPTION
        table_row_alt: '#FFFBF0',
        font: 'Inter',
        fontSize: '13px',
        headingSize: '28px'
      },
      decorations: [
        {
          asset: 'abstract_gradient_shapes',
          anchor: 'top-left',
          scale: 1.5,
          rotate: 0,
          colors: { fill: 'accent', opacity: 1.0 } // Yellow
        },
        {
          asset: 'layered_angular_shapes',
          anchor: 'top-right',
          scale: 1.0,
          rotate: 0,
          colors: { fill: 'primary', opacity: 1.0 } // Dark blue
        },
        {
          asset: 'layered_angular_shapes',
          anchor: 'bottom-left',
          scale: 1.0,
          rotate: 180,
          colors: { fill: 'primary', opacity: 1.0 } // Dark blue
        },
        {
          asset: 'abstract_gradient_shapes',
          anchor: 'bottom-right',
          scale: 1.5,
          rotate: 270,
          colors: { fill: 'accent', opacity: 1.0 } // Yellow
        }
      ],
      layout: [
        { block: 'Header', variant: 'invoice_left_logo_right', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'invoice_to_left_metadata_right', show_label: true },
        { block: 'ItemsTable', variant: 'colorful_alternating_headers', show_borders: false, stripe_rows: false },
        { block: 'Totals', variant: 'total_left_amount_right', show_borders: false },
        { block: 'Payment', variant: 'payment_box_left_thankyou_right', show_account_number: true },
        { block: 'Footer', variant: 'minimal', show_terms: false }
      ],
      spacing: { section_gap: '20px', item_gap: '8px', padding: '24px' }
    },

    // Template 3: Dark Grey Header with Pattern (Image 3 - Professional)
    {
      id: 'template_3',
      name: 'Dark Header Professional',
      description: 'Dark grey header with geometric pattern, white logo and clean layout',
      style: 'dark_header_professional',
      tokens: {
        primary: primary, // Dark grey/black
        secondary: '#9CA3AF', // Light grey for pattern
        accent: accent,
        text: text,
        background: background,
        border: border,
        table_header: primary, // Dark grey
        table_row_alt: '#F3F4F6',
        font: 'Inter',
        fontSize: '13px',
        headingSize: '24px'
      },
      decorations: [
        {
          asset: 'geometric_pattern_bg',
          anchor: 'top',
          scale: 1.0,
          rotate: 0,
          colors: { fill: 'secondary', opacity: 0.3 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'dark_header_logo_left_invoice_right', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'invoice_to_left_date_no_right_total_far_right', show_label: true },
        { block: 'ItemsTable', variant: 'blue_header', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'subtotal_tax_total_box_right', show_borders: false },
        { block: 'Payment', variant: 'payment_terms_left_signature_right', show_account_number: true },
        { block: 'Footer', variant: 'minimal', show_terms: false }
      ],
      spacing: { section_gap: '18px', item_gap: '8px', padding: '24px' }
    }
  ];

  return templates.map(template => ({
    ...template,
    generated_at: new Date().toISOString(),
    source: 'template_library'
  }));
}

module.exports = {
  generateTemplateLibrary
};
