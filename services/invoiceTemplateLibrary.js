/**
 * Invoice Template Library
 * Pre-designed beautiful invoice templates inspired by modern design trends
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
    // Template 1: Large Sweeping Curves (Hanover & Tyke style)
    {
      id: 'template_1',
      name: 'Elegant Curves',
      description: 'Large sweeping curves at top and bottom with professional layout',
      style: 'elegant_curves',
      tokens: {
        primary: primary,
        secondary: secondary,
        accent: accent,
        text: text,
        background: background,
        border: border,
        table_header: primary,
        table_row_alt: table_row_alt,
        font: 'Inter',
        fontSize: '13px',
        headingSize: '32px'
      },
      decorations: [
        {
          asset: 'large_sweeping_curve_top',
          anchor: 'top',
          scale: 1.4,
          rotate: 0,
          colors: { fill: 'primary', opacity: 1.0 }
        },
        {
          asset: 'large_sweeping_curve_bottom',
          anchor: 'bottom',
          scale: 1.3,
          rotate: 180,
          colors: { fill: 'primary', opacity: 1.0 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'logo_right_title_left', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'bill_to_payment_two_column', show_label: true },
        { block: 'ItemsTable', variant: 'blue_header', show_borders: true, stripe_rows: true },
        { block: 'Totals', variant: 'blue_total_box', show_borders: false },
        { block: 'Payment', variant: 'terms_conditions', show_account_number: true },
        { block: 'Footer', variant: 'minimal', show_terms: false }
      ],
      spacing: { section_gap: '20px', item_gap: '8px', padding: '24px' }
    },

    // Template 2: Angular Geometric Shapes (Borcelle style)
    {
      id: 'template_2',
      name: 'Geometric Angular',
      description: 'Sharp angular shapes in corners with layered geometric design',
      style: 'geometric_angular',
      tokens: {
        primary: primary,
        secondary: secondary,
        accent: accent,
        text: text,
        background: background,
        border: border,
        table_header: primary,
        table_row_alt: table_row_alt,
        font: 'Roboto',
        fontSize: '13px',
        headingSize: '30px'
      },
      decorations: [
        {
          asset: 'layered_angular_shapes',
          anchor: 'top-left',
          scale: 1.2,
          rotate: 0,
          colors: { fill: 'primary', opacity: 0.9 }
        },
        {
          asset: 'layered_angular_shapes',
          anchor: 'bottom-right',
          scale: 1.2,
          rotate: 180,
          colors: { fill: 'primary', opacity: 0.9 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'logo_left_invoice_right', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'issued_to_invoice_no', show_label: true },
        { block: 'ItemsTable', variant: 'blue_header', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'subtotal_total_bar', show_borders: false },
        { block: 'Payment', variant: 'bank_notes_two_column', show_account_number: true },
        { block: 'Footer', variant: 'minimal', show_terms: false }
      ],
      spacing: { section_gap: '18px', item_gap: '8px', padding: '24px' }
    },

    // Template 3: Arrowhead Banner (Wardiere style)
    {
      id: 'template_3',
      name: 'Arrowhead Banner',
      description: 'Bold arrowhead banner header with corner geometric accents',
      style: 'arrowhead_banner',
      tokens: {
        primary: primary,
        secondary: secondary,
        accent: accent,
        text: text,
        background: background,
        border: border,
        table_header: primary,
        table_row_alt: table_row_alt,
        font: 'Poppins',
        fontSize: '13px',
        headingSize: '28px'
      },
      decorations: [
        {
          asset: 'corner_geometric_accent',
          anchor: 'top-right',
          scale: 1.0,
          rotate: 0,
          colors: { fill: 'primary', opacity: 0.85 }
        },
        {
          asset: 'corner_geometric_accent',
          anchor: 'bottom-right',
          scale: 1.0,
          rotate: 180,
          colors: { fill: 'primary', opacity: 0.85 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'arrowhead_banner', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'bill_to_invoice_side_by_side', show_label: true },
        { block: 'ItemsTable', variant: 'blue_header_bordered', show_borders: true, stripe_rows: false },
        { block: 'Totals', variant: 'right_aligned_with_discount', show_borders: false },
        { block: 'Payment', variant: 'left_aligned', show_account_number: true },
        { block: 'Footer', variant: 'authorized_signature', show_terms: false }
      ],
      spacing: { section_gap: '18px', item_gap: '8px', padding: '24px' }
    },

    // Template 4: Vibrant Gradient Shapes (Yellow-Orange style)
    {
      id: 'template_4',
      name: 'Vibrant Gradient',
      description: 'Abstract overlapping gradient shapes in corners with colorful headers',
      style: 'vibrant_gradient',
      tokens: {
        primary: primary,
        secondary: secondary,
        accent: accent,
        text: text,
        background: background,
        border: border,
        table_header: accent,
        table_row_alt: '#FFF7ED',
        font: 'Lato',
        fontSize: '13px',
        headingSize: '28px'
      },
      decorations: [
        {
          asset: 'abstract_gradient_shapes',
          anchor: 'top-left',
          scale: 1.3,
          rotate: 0,
          colors: { fill: 'accent', opacity: 0.8 }
        },
        {
          asset: 'abstract_gradient_shapes',
          anchor: 'top-right',
          scale: 1.3,
          rotate: 90,
          colors: { fill: 'accent', opacity: 0.7 }
        },
        {
          asset: 'abstract_gradient_shapes',
          anchor: 'bottom-left',
          scale: 1.3,
          rotate: 180,
          colors: { fill: 'accent', opacity: 0.8 }
        },
        {
          asset: 'abstract_gradient_shapes',
          anchor: 'bottom-right',
          scale: 1.3,
          rotate: 270,
          colors: { fill: 'accent', opacity: 0.7 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'logo_left_invoice_details', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'billed_to_right', show_label: true },
        { block: 'ItemsTable', variant: 'colorful_alternating_headers', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'grand_total_button', show_borders: false },
        { block: 'Payment', variant: 'contact_info_footer', show_account_number: true },
        { block: 'Footer', variant: 'contact_grid', show_terms: false }
      ],
      spacing: { section_gap: '20px', item_gap: '8px', padding: '26px' }
    },

    // Template 5: Blue Gradient Header (Wave style)
    {
      id: 'template_5',
      name: 'Gradient Wave Header',
      description: 'Smooth blue gradient header with wave separation and clean layout',
      style: 'gradient_wave',
      tokens: {
        primary: primary,
        secondary: secondary,
        accent: accent,
        text: text,
        background: background,
        border: border,
        table_header: primary,
        table_row_alt: '#F1F5F9',
        font: 'Open Sans',
        fontSize: '13px',
        headingSize: '26px'
      },
      decorations: [
        {
          asset: 'gradient_wave_header',
          anchor: 'top',
          scale: 1.5,
          rotate: 0,
          colors: { fill: 'primary', opacity: 1.0 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'gradient_wave_header', show_logo: false, show_business_info: true },
        { block: 'CustomerInfo', variant: 'bill_from_two_column', show_label: true },
        { block: 'ItemsTable', variant: 'blue_header_zebra', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'blue_subtotal_box', show_borders: false },
        { block: 'Payment', variant: 'notes_payment_left', show_account_number: true },
        { block: 'Footer', variant: 'thank_you_large', show_terms: false }
      ],
      spacing: { section_gap: '18px', item_gap: '6px', padding: '24px' }
    },

    // Template 6: Modern Minimal with Accent Stripe
    {
      id: 'template_6',
      name: 'Modern Minimal Stripe',
      description: 'Clean minimal design with bold accent stripe and geometric accents',
      style: 'minimal_stripe',
      tokens: {
        primary: primary,
        secondary: secondary,
        accent: accent,
        text: text,
        background: background,
        border: border,
        table_header: '#F3F4F6',
        table_row_alt: '#FAFAFA',
        font: 'Inter',
        fontSize: '13px',
        headingSize: '24px'
      },
      decorations: [
        {
          asset: 'accent_stripe',
          anchor: 'left',
          scale: 1.0,
          rotate: 0,
          colors: { fill: 'accent', opacity: 1.0 }
        },
        {
          asset: 'minimal_geometric',
          anchor: 'bottom-right',
          scale: 0.9,
          rotate: 45,
          colors: { fill: 'primary', opacity: 0.1 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'minimal_with_stripe', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'two_column', show_label: true },
        { block: 'ItemsTable', variant: 'minimal_clean', show_borders: true, stripe_rows: true },
        { block: 'Totals', variant: 'right_aligned', show_borders: false },
        { block: 'Payment', variant: 'minimal', show_account_number: true },
        { block: 'Footer', variant: 'minimal_centered', show_terms: false }
      ],
      spacing: { section_gap: '20px', item_gap: '6px', padding: '28px' }
    },

    // Template 7: Corporate Classic with Border Frame
    {
      id: 'template_7',
      name: 'Corporate Classic',
      description: 'Professional corporate design with border frame and structured layout',
      style: 'corporate_classic',
      tokens: {
        primary: primary,
        secondary: secondary,
        accent: accent,
        text: text,
        background: background,
        border: border,
        table_header: primary,
        table_row_alt: '#F9FAFB',
        font: 'Roboto',
        fontSize: '13px',
        headingSize: '22px'
      },
      decorations: [
        {
          asset: 'border_frame',
          anchor: 'center',
          scale: 1.0,
          rotate: 0,
          colors: { fill: 'border', opacity: 0.5 }
        },
        {
          asset: 'corner_mark',
          anchor: 'top-left',
          scale: 0.6,
          rotate: 0,
          colors: { fill: 'accent', opacity: 0.15 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'classic_header', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'two_column', show_label: true },
        { block: 'ItemsTable', variant: 'bordered', show_borders: true, stripe_rows: true },
        { block: 'Totals', variant: 'right', show_borders: false },
        { block: 'Payment', variant: 'two_column', show_account_number: true },
        { block: 'Footer', variant: 'centered', show_terms: true }
      ],
      spacing: { section_gap: '18px', item_gap: '8px', padding: '24px' }
    },

    // Template 8: Bold Diagonal Split
    {
      id: 'template_8',
      name: 'Bold Diagonal',
      description: 'Striking diagonal split design with bold colors and modern typography',
      style: 'bold_diagonal',
      tokens: {
        primary: primary,
        secondary: secondary,
        accent: accent,
        text: text,
        background: background,
        border: border,
        table_header: accent,
        table_row_alt: '#FFF7ED',
        font: 'Poppins',
        fontSize: '13px',
        headingSize: '30px'
      },
      decorations: [
        {
          asset: 'diagonal_split',
          anchor: 'top-right',
          scale: 1.5,
          rotate: 0,
          colors: { fill: 'accent', opacity: 0.95 }
        },
        {
          asset: 'diagonal_split',
          anchor: 'bottom-left',
          scale: 1.5,
          rotate: 180,
          colors: { fill: 'primary', opacity: 0.15 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'diagonal_header', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'left', show_label: true },
        { block: 'ItemsTable', variant: 'accent_header_bold', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'bold_box', show_borders: false },
        { block: 'Payment', variant: 'left', show_account_number: true },
        { block: 'Footer', variant: 'minimal', show_terms: false }
      ],
      spacing: { section_gap: '20px', item_gap: '10px', padding: '24px' }
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
