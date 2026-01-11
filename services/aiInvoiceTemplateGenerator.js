const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * Generate beautiful, modern invoice template using AI
 * Creates dynamic HTML/CSS based on brand colors and invoice data
 */
async function generateAITemplate(invoiceData) {
  try {
    const {
      invoice,
      customer = {},
      store = {},
      items = [],
      logoUrl = null,
      colors = {}
    } = invoiceData;

    // Prepare invoice data for AI
    const businessName = store?.name || '';
    const businessTagline = store?.description || '';
    const customerName = customer?.name || '';
    const customerAddress = [customer?.address, customer?.city, customer?.state, customer?.country].filter(Boolean).join(', ');
    const customerEmail = customer?.email || '';
    const customerPhone = customer?.phone || '';

    const invoiceNumber = invoice?.invoice_number || 'INV-001';
    const issueDate = invoice?.issue_date || new Date().toISOString().split('T')[0];
    const dueDate = invoice?.due_date || '';
    const currency = invoice?.currency_symbol || (invoice?.currency === 'USD' ? '$' : invoice?.currency === 'GBP' ? '£' : invoice?.currency === 'EUR' ? '€' : invoice?.currency === 'NGN' ? '₦' : '$');
    
    const subtotal = Number(invoice?.subtotal || 0);
    const tax = Number(invoice?.tax_amount || 0);
    const discount = Number(invoice?.discount_amount || 0);
    const total = Number(invoice?.total || 0);
    
    const notes = invoice?.notes || '';

    // Format items for AI
    const itemsList = items.map((item, index) => ({
      name: item.item_name || item.name || `Item ${index + 1}`,
      quantity: Number(item.quantity || 0),
      price: Number(item.unit_price || item.price || 0),
      total: Number(item.total || (item.quantity || 0) * (item.unit_price || item.price || 0))
    }));

    // Brand colors
    const primary = colors.primary || '#2563EB';
    const secondary = colors.secondary || '#64748B';
    const accent = colors.accent || '#F59E0B';
    const text = colors.text || '#111827';
    const background = colors.background || '#FFFFFF';
    const border = colors.border || '#E5E7EB';

    // Use Gemini to generate beautiful invoice HTML
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

    const prompt = `You are an expert web designer specializing in professional invoice design. Generate a stunning, modern, beautiful invoice HTML template.

DESIGN REQUIREMENTS:
1. Create a visually stunning, professional invoice that looks premium and trustworthy
2. Use ONLY the provided brand colors throughout - create a cohesive, branded design
3. Modern design with:
   - Clean, elegant typography (use Google Fonts like Inter, Poppins, or Montserrat)
   - Beautiful gradients and subtle shadows for depth
   - Card-based layouts with rounded corners
   - Professional spacing and padding
   - Modern color schemes with proper contrast
4. Include all invoice data provided - make it clear and easy to read
5. Make it print-friendly (@media print styles)
6. Responsive design that works on all screen sizes
7. Include the logo prominently in the header if provided
8. Use creative, modern layouts:
   - Header with logo and invoice info in an elegant layout
   - Clean itemized table with alternating row colors
   - Beautiful summary section with highlighted totals
   - Professional footer with payment terms
9. Add subtle animations or hover effects where appropriate
10. Use modern CSS features: flexbox, grid, CSS variables, gradients

BRAND COLORS (use these throughout):
- Primary: ${primary}
- Secondary: ${secondary}
- Accent: ${accent}
- Text: ${text}
- Background: ${background}
- Border: ${border}

INVOICE DATA:
- Business Name: ${businessName}
- Business Tagline: ${businessTagline}
- Customer Name: ${customerName}
- Customer Address: ${customerAddress}
- Customer Email: ${customerEmail}
- Customer Phone: ${customerPhone}
- Invoice Number: ${invoiceNumber}
- Issue Date: ${issueDate}
- Due Date: ${dueDate}
- Currency: ${currency}

ITEMS:
${JSON.stringify(itemsList, null, 2)}

TOTALS:
- Subtotal: ${currency} ${subtotal.toFixed(2)}
- Tax: ${currency} ${tax.toFixed(2)}
- Discount: ${currency} ${discount.toFixed(2)}
- Total: ${currency} ${total.toFixed(2)}

NOTES: ${notes}

LOGO: ${logoUrl ? `Include logo at: ${logoUrl}` : 'No logo provided'}

Generate a complete, standalone HTML document with:
- Modern, beautiful, professional design that looks premium
- All CSS in a <style> tag in the <head>
- Use Google Fonts for typography (import from Google Fonts)
- Clean, elegant layout with proper spacing and padding
- Brand colors applied throughout (primary for headers, accent for highlights)
- Logo prominently displayed in header if provided
- Print-friendly styles (@media print)
- Responsive design (mobile-friendly)
- Modern UI elements:
  * Card-based sections with subtle shadows
  * Gradients for headers or accents
  * Rounded corners on cards and buttons
  * Professional table design with hover effects
  * Beautiful color-coded summary section
  * Elegant typography hierarchy
- Ensure all text is readable with proper contrast
- Make totals stand out with accent color
- Add subtle visual interest without being overwhelming

IMPORTANT:
- Return ONLY the complete HTML code
- No markdown formatting
- No explanations or comments
- Start with <!DOCTYPE html>
- End with </html>
- Make it look professional and beautiful
- Use the brand colors creatively but tastefully`;

    const result = await model.generateContent([prompt]);
    let html = result.response.text();

    // Clean up the response
    html = html.trim();
    
    // Remove markdown code blocks if present
    if (html.startsWith('```html')) {
      html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '');
    } else if (html.startsWith('```')) {
      html = html.replace(/```\n?/g, '');
    }

    // Ensure we have a valid HTML document
    if (!html.includes('<!DOCTYPE') && !html.includes('<!doctype')) {
      html = `<!DOCTYPE html>\n${html}`;
    }

    // Inject logo if provided
    if (logoUrl) {
      const logoHtml = `<img src="${logoUrl}" alt="${businessName}" style="max-width: 120px; max-height: 60px; object-fit: contain;" />`;
      // Try to inject logo into header if there's a placeholder or header section
      html = html.replace(/<header[^>]*>/i, (match) => {
        return match + logoHtml;
      });
      // Or add to body start if no header
      if (!html.includes(logoHtml)) {
        html = html.replace(/<body[^>]*>/i, (match) => {
          return match + `<div style="padding: 20px; text-align: center;">${logoHtml}</div>`;
        });
      }
    }

    return html;
  } catch (error) {
    console.error('Error generating AI invoice template:', error);
    throw new Error(`Failed to generate AI template: ${error.message}`);
  }
}

/**
 * Generate multiple AI template options
 */
async function generateAITemplateOptions(invoiceData, brandColors) {
  try {
    // Generate 3-4 different style variations
    const styles = [
      { name: 'Modern Minimal', description: 'Clean, minimal design with elegant spacing' },
      { name: 'Bold Professional', description: 'Bold colors with strong visual hierarchy' },
      { name: 'Elegant Classic', description: 'Classic design with modern touches' },
      { name: 'Creative Modern', description: 'Creative layout with unique design elements' }
    ];

    const templates = [];
    
    for (let i = 0; i < Math.min(styles.length, 4); i++) {
      const style = styles[i];
      try {
        const html = await generateAITemplate({
          ...invoiceData,
          colors: brandColors,
          style: style.name
        });
        
        templates.push({
          id: `ai_template_${i + 1}`,
          name: style.name,
          description: style.description,
          html: html,
          source: 'ai_generated',
          generated_at: new Date().toISOString()
        });
      } catch (error) {
        console.warn(`Failed to generate template ${i + 1}:`, error.message);
        // Continue with other templates
      }
    }

    return templates;
  } catch (error) {
    console.error('Error generating AI template options:', error);
    throw error;
  }
}

module.exports = {
  generateAITemplate,
  generateAITemplateOptions
};

