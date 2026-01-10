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
  // Check if Gemini API key is configured
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.trim() === '') {
    console.warn('GEMINI_API_KEY not set in environment. Using default templates.');
    return generateDefaultTemplates(brandColors);
  }

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

    console.log('Generating AI invoice templates with data:', {
      business_name,
      customer_name,
      items_count,
      total_amount,
      currency,
      industry
    });

    const prompt = `
You are an expert invoice design generator. Generate 5 COMPLETELY DIFFERENT and visually striking invoice template designs as JSON. Each template must have a UNIQUE design identity that looks completely different from the others.

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

CRITICAL REQUIREMENTS - Each template MUST be visually UNIQUE:

Template 1: **Bold Geometric Design**
- Large overlapping geometric shapes at the top (use diagonal_band or geometric_pattern)
- Strong angular shapes, triangular elements
- Bold header with geometric background
- High contrast, dynamic layout
- Use 1-2 large decorations at top corners (scale 1.3-1.5, opacity 0.15-0.25)
- Example: Large triangular shapes overlapping, bold accent colors

Template 2: **Elegant Flowing Curves**
- Subtle wave patterns flowing from corners (use wave_footer, organic_curve)
- Smooth, organic curves in background
- Soft, elegant design with flowing lines
- Use 2 decorations: one at top-right (organic_curve), one at bottom-left (wave_footer)
- Lower opacity (0.08-0.15) for sophisticated subtlety
- Example: Gentle waves from corners, soft flowing curves

Template 3: **Modern Minimalist with Accents**
- Clean design with ONE bold geometric element
- Sharp angles, stacked shapes (geometric_pattern)
- Minimal decorations but impactful
- Use geometric_pattern at one corner with medium scale (1.1-1.2)
- High contrast, clean lines
- Example: Stacked rectangular shapes at corner, clean layout

Template 4: **Sophisticated Curved Background**
- Multiple curved elements creating depth
- Use corner_swoosh at top-right AND bottom-left (different rotations)
- Wave patterns for elegance
- Medium opacity (0.12-0.18) for layered effect
- Example: Multiple swooshes creating depth, elegant curves

Template 5: **Bold Corner Accents**
- Strong corner elements (circle_stamp, corner_swoosh)
- Angular designs at opposite corners
- Bold use of accent colors
- Use 2 decorations at opposite corners (e.g., top-left circle_stamp, bottom-right corner_swoosh)
- Higher opacity (0.15-0.22) for impact
- Example: Large decorative circles/stamps at corners, bold accents

DESIGN RULES:

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
        "asset": "corner_swoosh" | "diagonal_band" | "wave_footer" | "circle_stamp" | "geometric_pattern" | "organic_curve" | null,
        "anchor": "top-right" | "top-left" | "bottom-right" | "bottom-left" | "center",
        "scale": 1.0-1.5,
        "rotate": 0 | 90 | 180 | 270,
        "colors": {
          "fill": "primary" | "secondary" | "accent",
          "stroke": "primary" | "secondary" | "accent" | null,
          "opacity": 0.08-0.25
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

CRITICAL DESIGN REQUIREMENTS:

1. **VISUAL VARIETY**: Each template must look COMPLETELY DIFFERENT. Do NOT use similar decoration styles across templates.
2. **DECORATION DIVERSITY**: 
   - Template 1: Use diagonal_band or geometric_pattern (bold, angular)
   - Template 2: Use organic_curve and wave_footer (flowing, elegant)
   - Template 3: Use geometric_pattern (modern, minimalist)
   - Template 4: Use corner_swoosh (multiple, layered curves)
   - Template 5: Use circle_stamp and corner_swoosh (bold accents)

3. **LAYOUT VARIETY**: 
   - Vary header positions: centered, left, split, minimal
   - Vary table styles: accent_header, zebra_stripes, bordered, minimal
   - Vary totals placement: right, left, two_column, highlighted
   - Vary spacing: different padding (20px, 32px, 40px) and gaps

4. **COLOR USAGE**: 
   - Use primary color for table headers and accents
   - Use accent color for decorative elements
   - Use secondary color for subtle backgrounds
   - Create visual hierarchy with color

5. **DECORATION PLACEMENT**:
   - Vary anchor positions (top-left, top-right, bottom-left, bottom-right, center)
   - Vary scales (1.0 for subtle, 1.5 for bold)
   - Vary rotations (0, 90, 180, 270 degrees)
   - Use 1-2 decorations per template for visual interest

6. **FONT VARIETY**: Use different fonts: Inter, Roboto, Open Sans, Lato, Poppins

7. **BACKGROUND DESIGN**: Some templates should have background decorative elements that create depth without overwhelming content

RETURN EXACTLY 5 TEMPLATES - EACH MUST BE VISUALLY UNIQUE AND DISTINCT!
Return ONLY valid JSON array, no markdown, no explanations, no code blocks.
`;

    console.log('Sending prompt to Gemini AI...');
    const result = await model.generateContent([prompt]);
    const responseText = result.response.text();
    
    console.log('Received AI response (first 200 chars):', responseText.substring(0, 200));
    
    // Clean response
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/```\n?/g, '');
    }
    
    // Remove any leading/trailing whitespace or newlines
    cleanedText = cleanedText.trim();
    
    let templates;
    try {
      templates = JSON.parse(cleanedText);
      console.log(`Successfully parsed ${Array.isArray(templates) ? templates.length : 0} templates from AI response`);
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', parseError.message);
      console.error('Response text:', cleanedText.substring(0, 500));
      throw new Error(`Failed to parse AI response: ${parseError.message}`);
    }

    // Validate and ensure we have exactly 5 templates
    if (!Array.isArray(templates)) {
      console.error('AI returned invalid response: templates is not an array', typeof templates);
      throw new Error('Templates must be an array');
    }

    if (templates.length === 0) {
      console.warn('AI returned empty templates array. Using default templates.');
      return generateDefaultTemplates(brandColors);
    }

    console.log(`AI generated ${templates.length} templates. Ensuring we have exactly 5...`);

    // Ensure we have 5 templates (generate defaults if needed)
    while (templates.length < 5) {
      templates.push(generateDefaultTemplate(templates.length + 1, brandColors));
    }

    // Limit to 5 and validate structure
    const validatedTemplates = templates.slice(0, 5).map((template, index) => {
      // Ensure required fields exist
      if (!template.id) {
        template.id = `template_${index + 1}`;
      }
      if (!template.name) {
        template.name = `Template ${index + 1}`;
      }
      if (!template.tokens) {
        template.tokens = {
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
        };
      }
      if (!template.layout) {
        template.layout = [
          { block: 'Header', variant: 'minimal', show_logo: true, show_business_info: true },
          { block: 'CustomerInfo', variant: 'left', show_label: true },
          { block: 'ItemsTable', variant: 'minimal', show_borders: false, stripe_rows: true },
          { block: 'Totals', variant: 'right', show_borders: false },
          { block: 'Payment', variant: 'minimal', show_account_number: true },
          { block: 'Footer', variant: 'centered', show_terms: false }
        ];
      }
      if (!template.spacing) {
        template.spacing = { section_gap: '32px', item_gap: '12px', padding: '32px' };
      }
      if (!template.decorations) {
        template.decorations = [];
      }

      return {
        ...template,
        generated_at: new Date().toISOString()
      };
    });

    console.log(`Successfully generated ${validatedTemplates.length} validated templates`);
    return validatedTemplates;
  } catch (error) {
    console.error('Error generating templates with AI:', error);
    console.error('Error details:', {
      message: error.message,
      name: error.name,
      stack: error.stack?.split('\n').slice(0, 5).join('\n'),
      hasApiKey: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '')
    });
    
    // Return default templates if AI generation fails
    console.log('Falling back to default templates...');
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
      name: 'Bold Geometric',
      description: 'Strong angular shapes with overlapping geometric elements for modern impact',
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
          asset: 'diagonal_band',
          anchor: 'top-right',
          scale: 1.4,
          rotate: 0,
          colors: { fill: 'accent', opacity: 0.22 }
        },
        {
          asset: 'geometric_pattern',
          anchor: 'top-left',
          scale: 1.2,
          rotate: 0,
          colors: { fill: 'primary', opacity: 0.18 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'centered', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'two_column', show_label: true },
        { block: 'ItemsTable', variant: 'accent_header', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'highlighted', show_borders: false },
        { block: 'Payment', variant: 'centered', show_account_number: true },
        { block: 'Footer', variant: 'centered', show_terms: false }
      ],
      spacing: { section_gap: '40px', item_gap: '16px', padding: '32px' }
    },
    {
      id: 'template_2',
      name: 'Elegant Waves',
      description: 'Flowing curves and wave patterns creating sophisticated elegance',
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
          asset: 'organic_curve',
          anchor: 'top-right',
          scale: 1.3,
          rotate: 0,
          colors: { fill: 'secondary', opacity: 0.12 }
        },
        {
          asset: 'wave_footer',
          anchor: 'bottom-left',
          scale: 1.2,
          rotate: 180,
          colors: { fill: 'accent', opacity: 0.10 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'minimal', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'right', show_label: true },
        { block: 'ItemsTable', variant: 'zebra_stripes', show_borders: true, stripe_rows: true },
        { block: 'Totals', variant: 'right', show_borders: false },
        { block: 'Payment', variant: 'two_column', show_account_number: true },
        { block: 'Footer', variant: 'left', show_terms: true }
      ],
      spacing: { section_gap: '32px', item_gap: '12px', padding: '40px' }
    },
    {
      id: 'template_3',
      name: 'Modern Minimal',
      description: 'Clean design with geometric accent elements',
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
        headingSize: '22px'
      },
      decorations: [
        {
          asset: 'geometric_pattern',
          anchor: 'top-right',
          scale: 1.1,
          rotate: 45,
          colors: { fill: 'primary', opacity: 0.15 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'logo_left_contact_right', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'left', show_label: true },
        { block: 'ItemsTable', variant: 'minimal', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'left', show_borders: true },
        { block: 'Payment', variant: 'minimal', show_account_number: true },
        { block: 'Footer', variant: 'minimal', show_terms: false }
      ],
      spacing: { section_gap: '24px', item_gap: '8px', padding: '32px' }
    },
    {
      id: 'template_4',
      name: 'Sophisticated Curves',
      description: 'Layered curved elements creating depth and elegance',
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
          asset: 'corner_swoosh',
          anchor: 'top-right',
          scale: 1.3,
          rotate: 0,
          colors: { fill: 'accent', opacity: 0.16 }
        },
        {
          asset: 'corner_swoosh',
          anchor: 'bottom-left',
          scale: 1.2,
          rotate: 180,
          colors: { fill: 'primary', opacity: 0.14 }
        },
        {
          asset: 'wave_footer',
          anchor: 'bottom-right',
          scale: 1.0,
          rotate: 270,
          colors: { fill: 'secondary', opacity: 0.10 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'split', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'two_column', show_label: true },
        { block: 'ItemsTable', variant: 'bordered', show_borders: true, stripe_rows: false },
        { block: 'Totals', variant: 'two_column', show_borders: true },
        { block: 'Payment', variant: 'two_column', show_account_number: true },
        { block: 'Footer', variant: 'centered', show_terms: true }
      ],
      spacing: { section_gap: '32px', item_gap: '12px', padding: '40px' }
    },
    {
      id: 'template_5',
      name: 'Bold Corner Accents',
      description: 'Strong decorative elements at corners with geometric patterns',
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
        headingSize: '24px'
      },
      decorations: [
        {
          asset: 'circle_stamp',
          anchor: 'top-left',
          scale: 1.2,
          rotate: 0,
          colors: { fill: 'primary', opacity: 0.18 }
        },
        {
          asset: 'corner_swoosh',
          anchor: 'bottom-right',
          scale: 1.4,
          rotate: 180,
          colors: { fill: 'accent', opacity: 0.20 }
        }
      ],
      layout: [
        { block: 'Header', variant: 'centered', show_logo: true, show_business_info: true },
        { block: 'CustomerInfo', variant: 'left', show_label: true },
        { block: 'ItemsTable', variant: 'accent_header', show_borders: false, stripe_rows: true },
        { block: 'Totals', variant: 'right', show_borders: false },
        { block: 'Payment', variant: 'centered', show_account_number: true },
        { block: 'Footer', variant: 'left', show_terms: false }
      ],
      spacing: { section_gap: '36px', item_gap: '14px', padding: '36px' }
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


