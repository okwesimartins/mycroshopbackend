const axios = require('axios');
const crypto = require('crypto');

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
      const xml2js = require('xml2js');
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
      const price = parseFloat(product.Price) || 0;
      const totalPrice = price * years;

      return {
        domain,
        tld,
        years,
        pricePerYear: price,
        totalPrice,
        currency: product.Currency || 'USD',
        productId: product.ProductId
      };
    } catch (error) {
      console.error('Error getting domain pricing:', error);
      throw error;
    }
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

      const params = {
        DomainName: domain,
        Years: years,
        'AuxBillingFirstName': firstName,
        'AuxBillingLastName': lastName,
        'AuxBillingEmailAddress': email,
        'AuxBillingPhone': phone,
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
        'RegistrantPhone': phone,
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
        'TechPhone': phone,
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
        'AdminPhone': phone,
        'AdminAddress1': address1,
        'AdminAddress2': address2 || '',
        'AdminCity': city,
        'AdminStateProvince': stateProvince,
        'AdminPostalCode': postalCode,
        'AdminCountry': country,
        'AdminPhoneExt': phoneExt,
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
      const response = await this.makeRequest('namecheap.domains.dns.getHosts', {
        DomainName: domain,
        Tld: domain.split('.').pop()
      });

      const hosts = response.CommandResponse?.DomainDNSGetHostsResult?.Host;
      
      if (!hosts) {
        return [];
      }

      // Handle both single host and array of hosts
      const hostList = Array.isArray(hosts) ? hosts : [hosts];

      return hostList.map(h => ({
        hostId: h.HostId,
        name: h.Name,
        type: h.Type,
        address: h.Address,
        mxPref: h.MXPref || null,
        ttl: h.TTL || '1800'
      }));
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

      const tld = domain.split('.').pop();
      const params = {
        DomainName: domain,
        Tld: tld
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

