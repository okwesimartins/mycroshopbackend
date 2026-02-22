const axios = require('axios');
const crypto = require('crypto');
const xml2js = require('xml2js');

/**
 * Namecheap API Service
 * Handles all Namecheap API interactions for domain operations
 * Uses sandbox environment by default
 */
class NamecheapService {
  constructor() {
    // Namecheap API credentials from environment
    this.apiUser = process.env.NAMECHEAP_API_USER;
    this.apiKey = process.env.NAMECHEAP_API_KEY;
    this.clientIp = process.env.NAMECHEAP_CLIENT_IP || '127.0.0.1';
    
    // Use sandbox by default (true unless explicitly set to 'false')
    // This ensures we test in sandbox first before going to production
    this.useSandbox = process.env.NAMECHEAP_USE_SANDBOX !== 'false';
    
    // API endpoints - SANDBOX is default for safety
    this.baseUrl = this.useSandbox 
      ? 'https://api.sandbox.namecheap.com/xml.response'
      : 'https://api.namecheap.com/xml.response';
    
    if (this.useSandbox) {
      console.log('🌐 Namecheap API: Using SANDBOX environment (safe for testing)');
    } else {
      console.log('⚠️  Namecheap API: Using PRODUCTION environment (real purchases)');
    }
    
    if (!this.apiUser || !this.apiKey) {
      console.warn('Namecheap API credentials not configured. Domain features will not work.');
    }
  }

  /**
   * Build query string with authentication parameters
   */
  buildQueryParams(command, params = {}) {
    const queryParams = {
      ApiUser: this.apiUser,
      ApiKey: this.apiKey,
      UserName: this.apiUser,
      Command: command,
      ClientIp: this.clientIp,
      ...params
    };

    return queryParams;
  }

  /**
   * Make API request to Namecheap
   */
  async makeRequest(command, params = {}) {
    if (!this.apiUser || !this.apiKey) {
      throw new Error('Namecheap API credentials not configured');
    }

    try {
      const queryParams = this.buildQueryParams(command, params);
      
      const response = await axios.get(this.baseUrl, {
        params: queryParams,
        timeout: 30000 // 30 second timeout
      });

      // Parse XML response
      const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
      const result = await parser.parseStringPromise(response.data);

      // Check for errors
      if (result.ApiResponse && result.ApiResponse.Status === 'ERROR') {
        const errors = result.ApiResponse.Errors;
        const errorMessages = Array.isArray(errors.Error) 
          ? errors.Error.map(e => e._ || e).join(', ')
          : errors.Error._ || errors.Error;
        
        throw new Error(`Namecheap API Error: ${errorMessages}`);
      }

      return result.ApiResponse;
    } catch (error) {
      if (error.response) {
        throw new Error(`Namecheap API HTTP Error: ${error.response.status} - ${error.response.statusText}`);
      }
      if (error.message.includes('Namecheap API')) {
        throw error;
      }
      throw new Error(`Namecheap API Request Failed: ${error.message}`);
    }
  }

  /**
   * Check domain availability
   * @param {string} domain - Domain name to check (e.g., "example.com")
   * @returns {Promise<object>} { available: boolean, domain: string, price?: number }
   */
  async checkDomainAvailability(domain) {
    try {
      // Remove protocol and www if present
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      
      const response = await this.makeRequest('namecheap.domains.check', {
        DomainList: cleanDomain
      });

      const domainCheck = response.CommandResponse?.DomainCheckResult;
      
      if (!domainCheck) {
        throw new Error('Invalid response from Namecheap API');
      }

      const available = domainCheck.Available === 'true' || domainCheck.Available === true;
      
      return {
        available,
        domain: cleanDomain,
        premium: domainCheck.PremiumRegistration === 'true' || domainCheck.PremiumRegistration === true,
        premiumPrice: domainCheck.PremiumRegistrationPrice || null,
        errorCode: domainCheck.ErrorNo || null
      };
    } catch (error) {
      console.error('Error checking domain availability:', error);
      throw error;
    }
  }

  /**
   * Get domain pricing information
   * @param {string} domain - Domain name
   * @param {number} years - Number of years (default: 1)
   * @returns {Promise<object>} Pricing information
   */
  async getDomainPricing(domain, years = 1) {
    try {
      const tld = domain.split('.').pop(); // Extract TLD (e.g., "com" from "example.com")
      
      const response = await this.makeRequest('namecheap.users.getPricing', {
        ProductType: 'DOMAIN',
        ActionName: 'REGISTER',
        ProductName: tld
      });

      const pricing = response.CommandResponse?.UserGetPricingResult?.ProductType?.ProductCategory?.Product;
      
      if (!pricing) {
        throw new Error('Could not retrieve pricing information');
      }

      // Handle both single product and array of products
      const product = Array.isArray(pricing) ? pricing[0] : pricing;
      let price = parseFloat(product.Price) || 0;
      
      // Sandbox API returns 0 prices - use mock pricing for testing
      if (this.useSandbox && price === 0) {
        // Mock pricing for common TLDs (approximate real prices for testing)
        const mockPrices = {
          'com': 12.98,
          'net': 14.98,
          'org': 14.98,
          'info': 2.99,
          'biz': 15.98,
          'co': 25.98,
          'io': 39.99,
          'xyz': 1.99,
          'online': 29.99,
          'store': 49.99,
          'shop': 19.99
        };
        
        price = mockPrices[tld.toLowerCase()] || 12.98; // Default to .com price
        
        console.log(`⚠️  Sandbox mode: Using mock pricing for ${tld} (real prices only available in production)`);
      }
      
      const totalPrice = price * years;

      return {
        domain,
        tld,
        years,
        pricePerYear: price,
        totalPrice,
        currency: product.Currency || 'USD',
        productId: product.ProductId,
        isSandbox: this.useSandbox && price > 0 && parseFloat(product.Price) === 0, // Flag if using mock pricing
        note: this.useSandbox && parseFloat(product.Price) === 0 
          ? 'Sandbox mode: Mock pricing shown. Real prices available in production.' 
          : null
      };
    } catch (error) {
      console.error('Error getting domain pricing:', error);
      throw error;
    }
  }

  /**
   * Format phone number for Namecheap API
   * Namecheap requires format: +CC.NNNNNNNNNN (e.g., +1.1234567890 or +234.1234567890)
   * @param {string} phone - Phone number in any format
   * @param {string} country - Country code (e.g., 'US', 'NG')
   * @returns {string} Formatted phone number
   */
  formatPhoneForNamecheap(phone, country = 'US') {
    if (!phone) return '';
    
    // Remove all non-digit characters except +
    let cleaned = phone.replace(/[^\d+]/g, '');
    
    // If already in correct format (has dot), return as-is
    if (phone.includes('.')) {
      return phone;
    }
    
    // Map country codes to phone prefixes
    const countryCodes = {
      'US': '1', 'CA': '1', 'NG': '234', 'GB': '44', 'KE': '254',
      'GH': '233', 'ZA': '27', 'EG': '20', 'TZ': '255', 'UG': '256',
      'IN': '91', 'PK': '92', 'BD': '880', 'LK': '94', 'NP': '977'
    };
    
    let countryCode;
    let number;
    
    // If it starts with +, extract country code
    if (cleaned.startsWith('+')) {
      // Try to match known country codes (1-3 digits)
      const match = cleaned.match(/^\+(\d{1,3})(.+)$/);
      if (match) {
        const [, extractedCode, rest] = match;
        // Check if extracted code matches a known country code
        const knownCode = Object.values(countryCodes).find(code => 
          extractedCode === code || extractedCode.startsWith(code) || code.startsWith(extractedCode)
        );
        if (knownCode) {
          countryCode = knownCode;
          number = rest;
        } else {
          // Use extracted code as-is
          countryCode = extractedCode;
          number = rest;
        }
      } else {
        // No match, use default
        countryCode = countryCodes[country.toUpperCase()] || '1';
        number = cleaned.replace(/^\+/, '');
      }
    } else {
      // No + prefix, add country code based on country parameter
      countryCode = countryCodes[country.toUpperCase()] || '1';
      number = cleaned;
    }
    
    // Remove leading zeros from number
    number = number.replace(/^0+/, '');
    
    // Ensure number is not empty
    if (!number) {
      // Fallback: use original phone if formatting fails
      console.warn(`⚠️  Phone number formatting failed for: ${phone}, using original`);
      return phone;
    }
    
    return `+${countryCode}.${number}`;
  }

  /**
   * Purchase/Register a domain
   * @param {object} domainData - Domain registration data
   * @returns {Promise<object>} Registration result
   */
  async registerDomain(domainData) {
    try {
      const {
        domain,
        years = 1,
        firstName,
        lastName,
        email,
        phone,
        address1,
        address2,
        city,
        stateProvince,
        postalCode,
        country = 'US',
        phoneExt = '',
        organization = '',
        jobTitle = '',
        idnCode = ''
      } = domainData;

      // Validate required fields
      if (!domain || !firstName || !lastName || !email || !phone || !address1 || !city || !stateProvince || !postalCode) {
        throw new Error('Missing required domain registration fields');
      }

      // Format phone number for Namecheap (required format: +CC.NNNNNNNNNN)
      const formattedPhone = this.formatPhoneForNamecheap(phone, country);
      
      console.log(`📞 Phone number formatting:`, {
        original: phone,
        country: country,
        formatted: formattedPhone
      });

      const params = {
        DomainName: domain,
        Years: years,
        'AuxBillingFirstName': firstName,
        'AuxBillingLastName': lastName,
        'AuxBillingEmailAddress': email,
        'AuxBillingPhone': formattedPhone,
        'AuxBillingAddress1': address1,
        'AuxBillingAddress2': address2 || '',
        'AuxBillingCity': city,
        'AuxBillingStateProvince': stateProvince,
        'AuxBillingPostalCode': postalCode,
        'AuxBillingCountry': country,
        'AuxBillingPhoneExt': phoneExt,
        'AuxBillingOrganizationName': organization,
        'AuxBillingJobTitle': jobTitle,
        'AuxBillingIdnCode': idnCode,
        // Registrant info (same as billing for simplicity)
        'RegistrantFirstName': firstName,
        'RegistrantLastName': lastName,
        'RegistrantEmailAddress': email,
        'RegistrantPhone': formattedPhone, // Use formatted phone
        'RegistrantAddress1': address1,
        'RegistrantAddress2': address2 || '',
        'RegistrantCity': city,
        'RegistrantStateProvince': stateProvince,
        'RegistrantPostalCode': postalCode,
        'RegistrantCountry': country,
        'RegistrantPhoneExt': phoneExt,
        'RegistrantOrganizationName': organization,
        'RegistrantJobTitle': jobTitle,
        'RegistrantIdnCode': idnCode,
        // Tech contact (same as registrant)
        'TechFirstName': firstName,
        'TechLastName': lastName,
        'TechEmailAddress': email,
        'TechPhone': formattedPhone, // Use formatted phone
        'TechAddress1': address1,
        'TechAddress2': address2 || '',
        'TechCity': city,
        'TechStateProvince': stateProvince,
        'TechPostalCode': postalCode,
        'TechCountry': country,
        'TechPhoneExt': phoneExt,
        'TechOrganizationName': organization,
        'TechJobTitle': jobTitle,
        'TechIdnCode': idnCode,
        // Admin contact (same as registrant)
        'AdminFirstName': firstName,
        'AdminLastName': lastName,
        'AdminEmailAddress': email,
        'AdminPhone': formattedPhone, // Use formatted phone
        'AdminAddress1': address1,
        'AdminAddress2': address2 || '',
        'AdminCity': city,
        'AdminStateProvince': stateProvince,
        'AdminPostalCode': postalCode,
        'AdminCountry': country,
        'AdminPhoneExt': phoneExt || '', // Empty string if not provided
        'AdminOrganizationName': organization,
        'AdminJobTitle': jobTitle,
        'AdminIdnCode': idnCode,
        // Nameservers (optional - can be set later)
        'Nameservers': '',
        // Enable privacy protection if available
        'AddFreeWhoisguard': 'yes',
        'WGEnabled': 'yes'
      };

      const response = await this.makeRequest('namecheap.domains.create', params);

      const result = response.CommandResponse?.DomainCreateResult;
      
      if (!result) {
        throw new Error('Invalid response from Namecheap API');
      }

      return {
        success: result.Domain === domain,
        domain: result.Domain,
        registered: result.Registered === 'true',
        chargedAmount: parseFloat(result.ChargedAmount) || 0,
        orderId: result.OrderID,
        transactionId: result.TransactionID
      };
    } catch (error) {
      console.error('Error registering domain:', error);
      throw error;
    }
  }

  /**
   * Get list of domains for the account
   * @param {string} listType - 'ALL', 'EXPIRING', 'EXPIRED' (default: 'ALL')
   * @param {number} page - Page number (default: 1)
   * @param {number} pageSize - Page size (default: 100)
   * @returns {Promise<object>} List of domains
   */
  async getDomainsList(listType = 'ALL', page = 1, pageSize = 100) {
    try {
      const response = await this.makeRequest('namecheap.domains.getList', {
        ListType: listType,
        Page: page,
        PageSize: pageSize
      });

      const domains = response.CommandResponse?.DomainGetListResult?.Domain;
      
      if (!domains) {
        return { domains: [], total: 0 };
      }

      // Handle both single domain and array of domains
      const domainList = Array.isArray(domains) ? domains : [domains];

      return {
        domains: domainList.map(d => ({
          name: d.Name,
          user: d.User,
          created: d.Created,
          expires: d.Expires,
          isExpired: d.IsExpired === 'true',
          isLocked: d.IsLocked === 'true',
          autoRenew: d.AutoRenew === 'true',
          whoisGuard: d.WhoisGuard === 'ENABLED'
        })),
        total: domainList.length
      };
    } catch (error) {
      console.error('Error getting domains list:', error);
      throw error;
    }
  }

  /**
   * Set nameservers for a domain
   * @param {string} domain - Domain name
   * @param {array} nameservers - Array of nameserver strings (e.g., ['ns1.example.com', 'ns2.example.com'])
   * @returns {Promise<object>} Result
   */
  async setNameservers(domain, nameservers) {
    try {
      if (!Array.isArray(nameservers) || nameservers.length === 0) {
        throw new Error('Nameservers must be a non-empty array');
      }

      const params = {
        DomainName: domain,
        Nameservers: nameservers.join(',')
      };

      const response = await this.makeRequest('namecheap.domains.dns.setNameservers', params);

      const result = response.CommandResponse?.DomainDNSSetNameserversResult;
      
      return {
        success: result.IsSuccess === 'true',
        domain: result.Domain
      };
    } catch (error) {
      console.error('Error setting nameservers:', error);
      throw error;
    }
  }

  /**
   * Get DNS host records for a domain
   * @param {string} domain - Domain name
   * @returns {Promise<array>} DNS records
   */
  async getDNSHostRecords(domain) {
    try {
      // Namecheap API requires SLD (Second Level Domain) and TLD (Top Level Domain) separately
      // Example: "example.com" -> SLD: "example", TLD: "COM"
      const domainParts = domain.split('.');
      if (domainParts.length < 2) {
        throw new Error(`Invalid domain format: ${domain}`);
      }
      
      // Extract TLD (last part, e.g., "com")
      const tld = domainParts.pop().toUpperCase();
      
      // Extract SLD (second-level domain, e.g., "example" from "example.com")
      // If domain is "sub.example.com", we want SLD="example" (not "sub.example")
      const sld = domainParts.length > 0 ? domainParts[domainParts.length - 1] : domainParts[0];
      
      if (!sld || !tld) {
        throw new Error(`Could not extract SLD and TLD from domain: ${domain}`);
      }
      
      console.log(`🔍 Domain parsing for DNS get: ${domain} -> SLD: ${sld}, TLD: ${tld}`);
      
      const response = await this.makeRequest('namecheap.domains.dns.getHosts', {
        SLD: sld, // Second Level Domain (required by Namecheap API)
        TLD: tld  // Top Level Domain (required by Namecheap API, uppercase)
      });

      // Log full response for debugging
      console.log(`📦 Full Namecheap API response for ${domain}:`, JSON.stringify(response, null, 2));

      const result = response.CommandResponse?.DomainDNSGetHostsResult;
      
      // Log full response for debugging if no result
      if (!result) {
        console.error(`❌ No DomainDNSGetHostsResult in response for ${domain}`);
        console.error(`   Full response:`, JSON.stringify(response, null, 2));
        throw new Error(`Invalid API response structure. No DomainDNSGetHostsResult found. Check API response format.`);
      }
      
      // Check if domain is using external nameservers (not Namecheap DNS)
      const isUsingOurDNS = result?.IsUsingOurDNS === 'true';
      
      if (!isUsingOurDNS) {
        console.log(`ℹ️  Domain ${domain} is using external nameservers, not Namecheap DNS`);
        return {
          records: [],
          usingExternalDNS: true,
          error: null
        };
      }
      
      // Get hosts - check multiple possible field names (case sensitivity)
      const hosts = result?.Host || result?.host || result?.HOST;
      
      if (!hosts) {
        console.log(`ℹ️  No DNS hosts found for domain ${domain}`);
        console.log(`   Available keys in result:`, Object.keys(result || {}));
        console.log(`   Full result:`, JSON.stringify(result, null, 2));
        return {
          records: [],
          usingExternalDNS: false,
          error: null,
          note: 'No hosts found in API response. Domain may not have DNS records configured yet, or records may be in a different format.'
        };
      }

      // Handle both single host and array of hosts
      const hostList = Array.isArray(hosts) ? hosts : [hosts];
      
      console.log(`✅ Found ${hostList.length} DNS record(s) for domain ${domain}`);
      console.log(`   Hosts data:`, JSON.stringify(hostList, null, 2));

      // Map hosts to records - handle case sensitivity
      const records = hostList.map(h => {
        // Handle case sensitivity - Namecheap might return different case
        const hostId = h.HostId || h.hostId || h.HostID || null;
        const name = h.Name || h.name || h.NAME || '@';
        const type = h.Type || h.type || h.TYPE || 'A';
        const address = h.Address || h.address || h.ADDRESS || '';
        const mxPref = h.MXPref || h.mxPref || h.MXPreference || h.MXPREF || null;
        const ttl = h.TTL || h.ttl || h.Ttl || '1800';
        
        return {
          hostId: hostId,
          name: name,
          type: type,
          address: address,
          mxPref: mxPref,
          ttl: ttl
        };
      });

      return {
        records: records,
        usingExternalDNS: false,
        error: null
      };
    } catch (error) {
      console.error('Error getting DNS host records:', error);
      throw error;
    }
  }

  /**
   * Set DNS host records for a domain
   * @param {string} domain - Domain name
   * @param {array} records - Array of DNS record objects
   * @returns {Promise<object>} Result
   */
  async setDNSHostRecords(domain, records) {
    try {
      if (!Array.isArray(records) || records.length === 0) {
        throw new Error('DNS records must be a non-empty array');
      }

      // Namecheap API requires SLD (Second Level Domain) and TLD (Top Level Domain) separately
      // Example: "example.com" -> SLD: "example", TLD: "COM"
      // For "sub.example.com", we still use SLD: "example", TLD: "COM" (ignore subdomain)
      const domainParts = domain.split('.');
      if (domainParts.length < 2) {
        throw new Error(`Invalid domain format: ${domain}`);
      }
      
      // Extract TLD (last part, e.g., "com")
      const tld = domainParts.pop().toUpperCase();
      
      // Extract SLD (second-level domain, e.g., "example" from "example.com")
      // If domain is "sub.example.com", we want SLD="example" (not "sub.example")
      // So we take the last part before TLD
      const sld = domainParts.length > 0 ? domainParts[domainParts.length - 1] : domainParts[0];
      
      if (!sld || !tld) {
        throw new Error(`Could not extract SLD and TLD from domain: ${domain}`);
      }
      
      console.log(`🔍 Domain parsing for DNS: ${domain} -> SLD: ${sld}, TLD: ${tld}`);
      
      const params = {
        SLD: sld, // Second Level Domain (required by Namecheap API)
        TLD: tld // Top Level Domain (required by Namecheap API, uppercase)
      };

      // Build parameters for each record
      records.forEach((record, index) => {
        params[`RecordType${index + 1}`] = record.type || 'A';
        params[`HostName${index + 1}`] = record.name || '@';
        params[`Address${index + 1}`] = record.address;
        params[`MXPref${index + 1}`] = record.mxPref || '10';
        params[`TTL${index + 1}`] = record.ttl || '1800';
      });

      const response = await this.makeRequest('namecheap.domains.dns.setHosts', params);

      const result = response.CommandResponse?.DomainDNSSetHostsResult;
      
      return {
        success: result.IsSuccess === 'true',
        domain: result.Domain
      };
    } catch (error) {
      console.error('Error setting DNS host records:', error);
      throw error;
    }
  }
}

// Export singleton instance
module.exports = new NamecheapService();

