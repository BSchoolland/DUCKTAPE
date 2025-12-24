/**
 * Vulnerability Scanner Module
 * Detects technologies on web pages using Wappalyzer and checks for CVEs
 * via OSV, Wordfence, and NVD APIs.
 */

import https from 'https';
import Wappalyzer from 'wappalyzer';

const WORDFENCE_API = 'https://www.wordfence.com/api/intelligence/v2/vulnerabilities/production';

// Cache for Wordfence data
let wordfenceCache = null;
let wordfenceCacheTime = 0;
const CACHE_TTL = 3600000; // 1 hour

// Wappalyzer category IDs that indicate npm packages
const NPM_CATEGORIES = new Set([
  59,  // javascript-libraries
  66,  // ui-frameworks
  12,  // javascript-frameworks
  19,  // miscellaneous (often JS tools)
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Lookup WordPress plugin slug from name via WordPress.org API
async function lookupWPSlug(pluginName) {
  return new Promise((resolve) => {
    const url = `https://api.wordpress.org/plugins/info/1.2/?action=query_plugins&search=${encodeURIComponent(pluginName)}&per_page=1`;
    https.get(url, { headers: { 'User-Agent': 'Ducktape-VulnScanner/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const plugin = result.plugins?.[0];
          if (plugin?.slug) resolve(plugin.slug);
          else resolve(null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Fetch and cache Wordfence vulnerability database
async function getWordfenceData() {
  if (wordfenceCache && Date.now() - wordfenceCacheTime < CACHE_TTL) {
    return wordfenceCache;
  }
  return new Promise((resolve) => {
    https.get(WORDFENCE_API, { headers: { 'User-Agent': 'Ducktape-VulnScanner/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) { resolve(null); return; }
          wordfenceCache = parsed;
          wordfenceCacheTime = Date.now();
          resolve(parsed);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Compare semver-like versions: returns -1 if a<b, 0 if equal, 1 if a>b
function compareVersions(a, b) {
  const pa = a.split('.').map(x => parseInt(x, 10) || 0);
  const pb = b.split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

// Check if version falls within a Wordfence affected range
function isVersionAffected(version, affectedVersions) {
  for (const range of Object.values(affectedVersions || {})) {
    const from = range.from_version === '*' ? '0' : range.from_version;
    const to = range.to_version;
    const fromCmp = compareVersions(version, from);
    const toCmp = compareVersions(version, to);
    const fromOk = range.from_inclusive ? fromCmp >= 0 : fromCmp > 0;
    const toOk = range.to_inclusive ? toCmp <= 0 : toCmp < 0;
    if (fromOk && toOk) return true;
  }
  return false;
}

// Query Wordfence for vulnerabilities affecting a WordPress plugin
async function checkWordfence(slug, version) {
  const data = await getWordfenceData();
  if (!data) return [];
  
  const vulns = [];
  for (const [id, vuln] of Object.entries(data)) {
    const software = vuln.software?.find(s => s.slug === slug && s.type === 'plugin');
    if (software && isVersionAffected(version, software.affected_versions)) {
      const score = vuln.cvss?.score || 5;
      let severity = 'LOW';
      if (score >= 9.0) severity = 'CRITICAL';
      else if (score >= 7.0) severity = 'HIGH';
      else if (score >= 4.0) severity = 'MEDIUM';
      vulns.push({
        cve: vuln.cve?.[0] || id,
        technology: slug,
        version,
        severity,
        cvss: score,
        source: 'Wordfence',
        description: (vuln.description?.slice(0, 2000) || vuln.title),
        url: `https://www.wordfence.com/threat-intel/vulnerabilities/id/${id}`
      });
    }
  }
  return vulns.sort((a, b) => b.cvss - a.cvss);
}

// Check if technology is a WordPress plugin based on Wappalyzer categories
function isWordPressPlugin(tech) {
  return tech.categories?.some(c => c.id === 87 || c.slug === 'wordpress-plugins');
}

// Check if technology is likely an npm package based on categories
function isNpmPackage(tech) {
  return tech.categories?.some(c => NPM_CATEGORIES.has(c.id));
}

// Normalize technology name/slug to npm package name
function normalizeToNpmName(tech) {
  const base = tech.slug || tech.name;
  return base.toLowerCase().replace(/\.js$/i, '').replace(/\s+/g, '-');
}

// Query OSV API for vulnerabilities
async function queryOSV(ecosystem, packageName, version) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      package: { name: packageName, ecosystem: ecosystem },
      version: version
    });

    const options = {
      hostname: 'api.osv.dev',
      port: 443,
      path: '/v1/query',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Ducktape-VulnScanner/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse OSV response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Parse CVSS vector string to extract base score
function parseCVSSVector(vectorStr) {
  if (!vectorStr) return null;
  
  const metrics = {};
  const parts = vectorStr.split('/');
  for (const part of parts) {
    const [key, val] = part.split(':');
    if (key && val) metrics[key] = val;
  }
  
  let score = 5.0;
  if (metrics.AV === 'N') score += 1.5;
  if (metrics.AC === 'L') score += 1.0;
  if (metrics.PR === 'N') score += 0.5;
  if (metrics.C === 'H') score += 1.0;
  if (metrics.I === 'H') score += 1.0;
  if (metrics.A === 'H') score += 0.5;
  
  return Math.min(10, score);
}

// Get severity info from OSV vulnerability
function getOSVSeverity(vuln) {
  if (vuln.database_specific?.severity) {
    const sev = vuln.database_specific.severity.toUpperCase();
    const normalizedSev = sev === 'MODERATE' ? 'MEDIUM' : sev;
    const scoreMap = { CRITICAL: 9.5, HIGH: 7.5, MEDIUM: 5.5, LOW: 2.5 };
    
    let actualScore = scoreMap[normalizedSev] || 5;
    if (vuln.severity && vuln.severity.length > 0) {
      for (const sevInfo of vuln.severity) {
        if (sevInfo.type === 'CVSS_V3' || sevInfo.type === 'CVSS_V4') {
          const parsed = parseCVSSVector(sevInfo.score);
          if (parsed) actualScore = parsed;
          break;
        }
      }
    }
    
    return { score: actualScore, severity: normalizedSev };
  }
  
  if (vuln.severity && vuln.severity.length > 0) {
    for (const sev of vuln.severity) {
      if (sev.type === 'CVSS_V3' || sev.type === 'CVSS_V4') {
        const score = parseCVSSVector(sev.score) || 5;
        let severity = 'LOW';
        if (score >= 9.0) severity = 'CRITICAL';
        else if (score >= 7.0) severity = 'HIGH';
        else if (score >= 4.0) severity = 'MEDIUM';
        return { score, severity };
      }
    }
  }
  
  return { score: 5, severity: 'UNKNOWN' };
}

// Get severity info from NVD CVE
function getNVDSeverity(vuln) {
  const metrics = vuln.cve?.metrics;
  if (!metrics) return { score: 5, severity: 'UNKNOWN' };
  
  if (metrics.cvssMetricV31?.[0]) {
    const cvss = metrics.cvssMetricV31[0].cvssData;
    return { score: cvss.baseScore, severity: cvss.baseSeverity };
  }
  if (metrics.cvssMetricV30?.[0]) {
    const cvss = metrics.cvssMetricV30[0].cvssData;
    return { score: cvss.baseScore, severity: cvss.baseSeverity };
  }
  if (metrics.cvssMetricV2?.[0]) {
    const cvss = metrics.cvssMetricV2[0].cvssData;
    return { score: cvss.baseScore, severity: cvss.baseSeverity || 'UNKNOWN' };
  }
  return { score: 5, severity: 'UNKNOWN' };
}

// Query NVD API with exact CPE match
async function queryNVDCPE(cpeName) {
  const NVD_API_BASE = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
  return new Promise((resolve, reject) => {
    const url = `${NVD_API_BASE}?cpeName=${encodeURIComponent(cpeName)}`;
    const options = { headers: { 'User-Agent': 'Ducktape-VulnScanner/1.0' } };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse NVD response: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// Build versioned CPE from template
function buildVersionedCPE(cpeTemplate, version) {
  if (!cpeTemplate || !version) return null;
  const parts = cpeTemplate.split(':');
  if (parts.length >= 6) {
    parts[5] = version;
    return parts.join(':');
  }
  return null;
}

// Check a technology for vulnerabilities (silent - no console output)
async function checkTechnology(tech) {
  const results = [];
  
  // 1. WordPress plugins → Wordfence
  if (isWordPressPlugin(tech)) {
    const wpSlug = await lookupWPSlug(tech.name);
    if (wpSlug) {
      const wfVulns = await checkWordfence(wpSlug, tech.version);
      for (const vuln of wfVulns) {
        results.push({
          ...vuln,
          technology: tech.name,
        });
      }
      return results;
    }
  }
  
  // 2. JavaScript libraries/frameworks → npm + OSV
  if (isNpmPackage(tech)) {
    const npmName = normalizeToNpmName(tech);
    
    try {
      const osvResult = await queryOSV('npm', npmName, tech.version);
      const vulns = osvResult.vulns || [];
      
      for (const vuln of vulns) {
        const severity = getOSVSeverity(vuln);
        const cveId = vuln.aliases?.find(a => a.startsWith('CVE-')) || vuln.id;
        const vulnUrl = vuln.references?.find(r => r.type === 'ADVISORY')?.url 
          || vuln.references?.[0]?.url 
          || `https://osv.dev/vulnerability/${vuln.id}`;
        
        results.push({
          cve: cveId,
          technology: tech.name,
          version: tech.version,
          severity: severity.severity,
          cvss: severity.score,
          source: 'OSV',
          description: (vuln.summary || vuln.details || '').slice(0, 2000),
          url: vulnUrl
        });
      }
      return results;
    } catch {
      // OSV query failed, continue to fallback
    }
  }
  
  // 3. Try NVD with CPE if available
  if (tech.cpe) {
    const versionedCPE = buildVersionedCPE(tech.cpe, tech.version);
    if (versionedCPE) {
      try {
        const nvdResult = await queryNVDCPE(versionedCPE);
        const vulns = nvdResult.vulnerabilities || [];
        
        for (const vuln of vulns) {
          const severity = getNVDSeverity(vuln);
          results.push({
            cve: vuln.cve.id,
            technology: tech.name,
            version: tech.version,
            severity: severity.severity,
            cvss: severity.score,
            source: 'NVD-CPE',
            description: (vuln.cve.descriptions?.find(d => d.lang === 'en')?.value || vuln.cve.descriptions?.[0]?.value || '').slice(0, 2000),
            url: `https://nvd.nist.gov/vuln/detail/${vuln.cve.id}`
          });
        }
        return results;
      } catch {
        // NVD query failed, continue to fallback
      }
    }
  }
  
  // 4. Fallback: Try npm/OSV for any unidentified technology
  const npmName = normalizeToNpmName(tech);
  
  try {
    const osvResult = await queryOSV('npm', npmName, tech.version);
    const vulns = osvResult.vulns || [];
    
    for (const vuln of vulns) {
      const severity = getOSVSeverity(vuln);
      const cveId = vuln.aliases?.find(a => a.startsWith('CVE-')) || vuln.id;
      const vulnUrl = vuln.references?.find(r => r.type === 'ADVISORY')?.url 
        || vuln.references?.[0]?.url 
        || `https://osv.dev/vulnerability/${vuln.id}`;
      
      results.push({
        cve: cveId,
        technology: tech.name,
        version: tech.version,
        severity: severity.severity,
        cvss: severity.score,
        source: 'OSV',
        description: (vuln.summary || vuln.details || '').slice(0, 2000),
        url: vulnUrl
      });
    }
  } catch {
    // Fallback failed, return empty results
  }
  
  return results;
}

/**
 * Scan a URL for technologies and vulnerabilities
 * @param {string} url - The URL to scan
 * @returns {Promise<{technologies: Array, vulnerabilities: Array}>}
 */
export async function scanUrl(url) {
  const wappalyzer = new Wappalyzer({ debug: false });
  
  try {
    await wappalyzer.init();
    const site = await wappalyzer.open(url);
    const results = await site.analyze();
    await wappalyzer.destroy();
    
    const technologies = results.technologies || [];
    
    // Filter to only those with version
    const checkable = technologies.filter(t => t.version);
    
    if (checkable.length === 0) {
      return { technologies, vulnerabilities: [] };
    }
    
    const allVulns = [];
    
    for (const tech of checkable) {
      const vulns = await checkTechnology(tech);
      allVulns.push(...vulns);
      // Small delay between checks to avoid rate limiting
      await sleep(100);
    }
    
    // Sort by CVSS score descending
    allVulns.sort((a, b) => (b.cvss || 0) - (a.cvss || 0));
    
    return { technologies, vulnerabilities: allVulns };
    
  } catch (err) {
    await wappalyzer.destroy().catch(() => {});
    throw err;
  }
}

/**
 * Get counts of vulnerabilities by severity
 * @param {Array} vulnerabilities - Array of vulnerability objects
 * @returns {{critical: number, high: number, medium: number, low: number, total: number}}
 */
export function getVulnCounts(vulnerabilities) {
  return {
    critical: vulnerabilities.filter(v => v.severity === 'CRITICAL').length,
    high: vulnerabilities.filter(v => v.severity === 'HIGH').length,
    medium: vulnerabilities.filter(v => v.severity === 'MEDIUM').length,
    low: vulnerabilities.filter(v => v.severity === 'LOW').length,
    total: vulnerabilities.length,
  };
}

/**
 * Filter vulnerabilities to only HIGH and CRITICAL
 * @param {Array} vulnerabilities - Array of vulnerability objects
 * @returns {Array}
 */
export function getHighAndCritical(vulnerabilities) {
  return vulnerabilities.filter(v => v.severity === 'HIGH' || v.severity === 'CRITICAL');
}

export default { scanUrl, getVulnCounts, getHighAndCritical };

