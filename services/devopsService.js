const axios = require('axios');

// Localized axios clients
function getGithubClient() {
  const baseURL = process.env.GITHUB_API_BASE_URL || 'https://api.github.com';
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return null;
  }
  return axios.create({
    baseURL,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Deeps-Systems-AIO'
    }
  });
}

function getVultrClient() {
  const baseURL = process.env.VULTR_API_BASE_URL || 'https://api.vultr.com/v2';
  const apiKey = process.env.VULTR_API_KEY;
  if (!apiKey) {
    return null;
  }
  return axios.create({
    baseURL,
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
}

function getHostgatorClient() {
  const baseURL = process.env.HOSTGATOR_API_BASE_URL || 'https://api.hostgator.com/v1';
  const apiKey = process.env.HOSTGATOR_API_KEY;
  if (!apiKey) {
    return null;
  }
  return axios.create({
    baseURL,
    headers: {
      'X-HostGator-API-Key': apiKey
    }
  });
}

async function listProviderResources(provider) {
  const prov = (provider || '').toLowerCase();
  
  if (prov === 'github') {
    const client = getGithubClient();
    if (!client) {
      return { success: false, message: 'GitHub credentials are unset' };
    }
    try {
      const response = await client.get('/user/repos');
      return { success: true, resources: response.data };
    } catch (error) {
      return {
        success: false,
        message: `GitHub API error: ${error.response?.data?.message || error.message}`
      };
    }
  }
  
  if (prov === 'vultr') {
    const client = getVultrClient();
    if (!client) {
      return { success: false, message: 'Vultr credentials are unset' };
    }
    try {
      const response = await client.get('/instances');
      return { success: true, resources: response.data?.instances || response.data };
    } catch (error) {
      return {
        success: false,
        message: `Vultr API error: ${error.response?.data?.error || error.message}`
      };
    }
  }
  
  if (prov === 'hostgator') {
    const client = getHostgatorClient();
    if (!client) {
      return { success: false, message: 'HostGator credentials are unset' };
    }
    try {
      const response = await client.get('/accounts');
      return { success: true, resources: response.data?.accounts || response.data };
    } catch (error) {
      return {
        success: false,
        message: `HostGator API error: ${error.response?.data?.message || error.message}`
      };
    }
  }
  
  return { success: false, message: `Unsupported provider: ${provider}` };
}

module.exports = {
  listProviderResources
};
