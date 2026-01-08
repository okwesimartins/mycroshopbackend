const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * Generate invoice template options using AI
 * @param {Object} invoiceData - Invoice data
 * @param {Object} brandColors - Brand color palette
 * @returns {Promise<Array>} Array of template JSON objects
 */
async function generateTemplateOptions(invoiceData, brandColors) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

    const {
      business_name,
      business_email,
      business_phone,
      customer_name,
      items_count,
      total_amount,
      currency = 'NGN',
      industry
    } = invoiceData;

    const prompt = `
You are an expert invoice design generator. Given invoice data and brand colors, generate 5 visually distinct, professional invoice template designs as JSON.

Invoice Context:
- Business: ${business_name || 'Business Name'}
- Customer: ${customer_name || 'Customer'}
- Items: ${items_count || 0} line items
- Total: ${currency} ${total_amount || '0.00'}
- Industry: ${industry || 'General'}

Brand Colors:
- Primary: ${brandColors.primary}
- Secondary: ${brandColors.secondary}
- Accent: ${brandColors.accent}
- Text: ${brandColors.text}
- Background: ${brandColors.background}
- Border: ${brandColors.border}

Generate 5 different templates. Each template must have:

1. **Unique visual style** (modern, classic, minimalist, bold, elegant)
2. **Different layout arrangements** (header positions, table styles, totals placement)
3. **Varied decoration usage** (some with curves, some minimal, some geometric)
4. **Professional appearance** suitable for business invoices

Template Structure (return as JSON array):
[
  {
    "id": "template_1",
    "name": "Template Name (e.g., Modern Minimalist)",
    "description": "Brief description of the design style",
    "tokens": {
      "primary": "${brandColors.primary}",
      "secondary": "${brandColors.secondary}",
      "accent": "${brandColors.accent}",
      "text": "${brandColors.text}",
      "background": "${brandColors.background}",
      "border": "${brandColors.border}",
      "table_header": "${brandColors.table_header}",
      "table_row_alt": "${brandColors.table_row_alt}",
      "font": "Inter" | "Roboto" | "Open Sans" | "Lato" | "Poppins",
      "fontSize": "14px",
      "headingSize": "24px"
    },
    "decorations": [
      {
        "asset": "corner_swoosh" | "diagonal_band" | "wave_footer" | "circle_stamp" | "geometric_pattern" | null,
        "anchor": "top-right" | "top-left" | "bottom-right" | "bottom-left" | "center",
        "scale": 1.0-1.5,
        "rotate": 0 | 90 | 180 | 270,
        "colors": {
          "fill": "primary" | "secondary" | "accent",
          "stroke": "primary" | "secondary" | "accent" | null,
          "opacity": 0.1-0.3
        }
      }
    ],
    "layout": [
      {
        "block": "Header",
        "variant": "logo_left_contact_right" | "centered" | "minimal" | "split",
        "show_logo": true | false,
        "show_business_info": true | false
      },
      {
        "block": "CustomerInfo",
        "variant": "left" | "right" | "two_column",
        "show_label": true | false
      },
      {
        "block": "ItemsTable",
        "variant": "accent_header" | "zebra_stripes" | "bordered" | "minimal" | "highlighted",
        "show_borders": true | false,
        "stripe_rows": true | false
      },
      {
        "block": "Totals",
        "variant": "right" | "left" | "two_column" | "highlighted",
        "show_borders": true | false
      },
      {
        "block": "Payment",
        "variant": "two_column" | "centered" | "minimal",
        "show_account_number": true | false
      },
      {
        "block": "Footer",
        "variant": "centered" | "left" | "minimal",
        "show_terms": true | false
      }
    ],
    "spacing": {
      "section_gap": "24px" | "32px" | "40px",
      "item_gap": "8px" | "12px" | "16px",
      "padding": "20px" | "32px" | "40px"
    }
  }
]

Requirements:
- Each template must be visually distinct
- Use brand colors intelligently (not overwhelming)
- Ensure readability and professionalism
- Include 0-2 decorations per template (some can be minimal)
- Vary font choices and layouts
- Return exactly 5 templates
- Return ONLY valid JSON array, no markdown, no explanations
`;

    const result = await model.generateContent([prompt]);
    const responseText = result.response.text();
    
    // Clean response
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/```\n?/g, '');
    }
    
    // Remove any leading/trailing whitespace or newlines
    cleanedText = cleanedText.trim();
    
    const templates = JSON.parse(cleanedText);

    // Validate and ensure we have exactly 5 templates
    if (!Array.isArray(templates)) {
      throw new Error('Templates must be an array');
    }

    // Ensure we have 5 templates (generate defaults if needed)
    while (templates.length < 5) {
      templates.push(generateDefaultTemplate(templates.length + 1, brandColors));
    }

    // Limit to 5
    return templates.slice(0, 5).map((template, index) => ({
      ...template,
      id: template.id || `template_${index + 1}`,
      name: template.name || `Template ${index + 1}`,
      generated_at: new Date().toISOString()
    }));
  } catch (error) {
    console.error('Error generating templates:', error);
    
    // Return default templates if AI generation fails
    return generateDefaultTemplates(brandColors);
  }
}

/**
 * Generate default templates if AI fails
 */
function generateDefaultTemplates(brandColors) {
  return [
    {
      id: 'template_1',
      name: 'Modern Minimalist',
      description: 'Clean and simple design with minimal decorations',
      tokens: {
        primary: brandColors.primary,
        secondary: brandColors.secondary,
        accent: brandColors.accent,
        text: brandColors.text,
        background: brandColors.background,
        border: brandColors.border,
        table_header: brandColors.table_header,
        table_row_alt: brandColors.table_row_alt,
        font: 'Inter',
        fontSize: '14px',
        headingSize: '24px'
      },
      decorations: [],
      layout: [
        { block: 'Header', variant: 'minimal', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'left', show_label: true },
        { block: 'ItemsTable', variant: 'minimal', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'right', show_borders: false },
        { block: 'Payment', variant: 'minimal', show_account_number: true },
        { block: 'Footer', variant: 'centered', show_terms: false }
      ],
      spacing: { section_gap: '32px', item_gap: '12px', padding: '32px' }
    },
    {
      id: 'template_2',
      name: 'Classic Professional',
      description: 'Traditional business invoice with structured layout',
      tokens: {
        primary: brandColors.primary,
        secondary: brandColors.secondary,
        accent: brandColors.accent,
        text: brandColors.text,
        background: brandColors.background,
        border: brandColors.border,
        table_header: brandColors.table_header,
        table_row_alt: brandColors.table_row_alt,
        font: 'Roboto',
        fontSize: '14px',
        headingSize: '26px'
      },
      decorations: [
        {
          asset: 'diagonal_band',
          anchor: 'top-right',
          scale: 1.2,
          rotate: 0,
          colors: { fill: 'primary', opacity: 0.1 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'logo_left_contact_right', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'two_column', show_label: true },
        { block: 'ItemsTable', variant: 'bordered', show_borders: true, stripe_rows: false },
        { block: 'Totals', variant: 'two_column', show_borders: true },
        { block: 'Payment', variant: 'two_column', show_account_number: true },
        { block: 'Footer', variant: 'left', show_terms: true }
      ],
      spacing: { section_gap: '24px', item_gap: '8px', padding: '40px' }
    },
    {
      id: 'template_3',
      name: 'Bold Accent',
      description: 'Vibrant design with strong color accents',
      tokens: {
        primary: brandColors.primary,
        secondary: brandColors.secondary,
        accent: brandColors.accent,
        text: brandColors.text,
        background: brandColors.background,
        border: brandColors.border,
        table_header: brandColors.table_header,
        table_row_alt: brandColors.table_row_alt,
        font: 'Poppins',
        fontSize: '14px',
        headingSize: '28px'
      },
      decorations: [
        {
          asset: 'corner_swoosh',
          anchor: 'top-right',
          scale: 1.05,
          rotate: 0,
          colors: { fill: 'accent', opacity: 0.15 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'centered', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'left', show_label: true },
        { block: 'ItemsTable', variant: 'accent_header', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'highlighted', show_borders: false },
        { block: 'Payment', variant: 'centered', show_account_number: true },
        { block: 'Footer', variant: 'centered', show_terms: false }
      ],
      spacing: { section_gap: '40px', item_gap: '16px', padding: '32px' }
    },
    {
      id: 'template_4',
      name: 'Elegant Curves',
      description: 'Sophisticated design with decorative elements',
      tokens: {
        primary: brandColors.primary,
        secondary: brandColors.secondary,
        accent: brandColors.accent,
        text: brandColors.text,
        background: brandColors.background,
        border: brandColors.border,
        table_header: brandColors.table_header,
        table_row_alt: brandColors.table_row_alt,
        font: 'Lato',
        fontSize: '14px',
        headingSize: '24px'
      },
      decorations: [
        {
          asset: 'corner_swoosh',
          anchor: 'top-right',
          scale: 1.1,
          rotate: 0,
          colors: { fill: 'primary', stroke: 'accent', opacity: 0.2 }
        },
        {
          asset: 'corner_swoosh',
          anchor: 'bottom-left',
          scale: 1.1,
          rotate: 180,
          colors: { fill: 'secondary', opacity: 0.15 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'split', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'right', show_label: true },
        { block: 'ItemsTable', variant: 'zebra_stripes', show_borders: true, stripe_rows: true },
        { block: 'Totals', variant: 'right', show_borders: false },
        { block: 'Payment', variant: 'two_column', show_account_number: true },
        { block: 'Footer', variant: 'centered', show_terms: true }
      ],
      spacing: { section_gap: '32px', item_gap: '12px', padding: '40px' }
    },
    {
      id: 'template_5',
      name: 'Clean Grid',
      description: 'Structured grid-based layout',
      tokens: {
        primary: brandColors.primary,
        secondary: brandColors.secondary,
        accent: brandColors.accent,
        text: brandColors.text,
        background: brandColors.background,
        border: brandColors.border,
        table_header: brandColors.table_header,
        table_row_alt: brandColors.table_row_alt,
        font: 'Open Sans',
        fontSize: '14px',
        headingSize: '22px'
      },
      decorations: [
        {
          asset: 'geometric_pattern',
          anchor: 'center',
          scale: 1.0,
          rotate: 0,
          colors: { fill: 'border', opacity: 0.05 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'logo_left_contact_right', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'two_column', show_label: true },
        { block: 'ItemsTable', variant: 'bordered', show_borders: true, stripe_rows: false },
        { block: 'Totals', variant: 'left', show_borders: true },
        { block: 'Payment', variant: 'minimal', show_account_number: true },
        { block: 'Footer', variant: 'minimal', show_terms: false }
      ],
      spacing: { section_gap: '24px', item_gap: '8px', padding: '32px' }
    }
  ].map(template => ({
    ...template,
    generated_at: new Date().toISOString()
  }));
}

/**
 * Generate a single default template
 */
function generateDefaultTemplate(index, brandColors) {
  const templates = generateDefaultTemplates(brandColors);
  return {
    ...templates[index % templates.length],
    id: `template_${index}`,
    name: `Template ${index}`
  };
}

module.exports = {
  generateTemplateOptions
};


