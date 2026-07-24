const axios = require('axios');
const db = require('../db');

// Helper to retrieve decrypted per-tenant credentials from database
async function getCredential(provider, tenantId) {
  if (!tenantId) {
    return null;
  }
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!key) {
    return null;
  }
  try {
    const query = `
      SELECT pgp_sym_decrypt(secret_encrypted, $1) AS secret, base_url
      FROM devops_credentials
      WHERE tenant_id = $2 AND LOWER(provider) = $3
    `;
    const { rows } = await db.query(query, [key, tenantId, provider.toLowerCase()]);
    if (rows.length > 0) {
      return {
        secret: rows[0].secret,
        baseUrl: rows[0].base_url
      };
    }
  } catch (error) {
    console.error(`[devopsService] Error retrieving decrypted credential for ${provider}:`, error);
  }
  return null;
}

// Localized axios clients
async function getGithubClient(tenantId) {
  const cred = await getCredential('github', tenantId);
  const baseURL = (cred && cred.baseUrl) || process.env.GITHUB_API_BASE_URL || 'https://api.github.com';
  const token = (cred && cred.secret) || process.env.GITHUB_TOKEN;
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

async function getVultrClient(tenantId) {
  const cred = await getCredential('vultr', tenantId);
  const baseURL = (cred && cred.baseUrl) || process.env.VULTR_API_BASE_URL || 'https://api.vultr.com/v2';
  const apiKey = (cred && cred.secret) || process.env.VULTR_API_KEY;
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

async function getHostgatorClient(tenantId) {
  const cred = await getCredential('hostgator', tenantId);
  const baseURL = (cred && cred.baseUrl) || process.env.HOSTGATOR_API_BASE_URL || 'https://api.hostgator.com/v1';
  const apiKey = (cred && cred.secret) || process.env.HOSTGATOR_API_KEY;
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

async function getCoolifyClient(tenantId) {
  const cred = await getCredential('coolify', tenantId);
  const baseURL = (cred && cred.baseUrl) || process.env.COOLIFY_API_BASE_URL || 'https://app.coolify.io/api/v1';
  const apiKey = (cred && cred.secret) || process.env.COOLIFY_API_KEY;
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

async function listProviderResources(provider, tenantId) {
  const prov = (provider || '').toLowerCase();
  
  if (prov === 'github') {
    const client = await getGithubClient(tenantId);
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
    const client = await getVultrClient(tenantId);
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
    const client = await getHostgatorClient(tenantId);
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
  
  if (prov === 'coolify') {
    const client = await getCoolifyClient(tenantId);
    if (!client) {
      return { success: false, message: 'Coolify credentials are unset' };
    }
    try {
      const [appsResult, projectsResult, serversResult] = await Promise.allSettled([
        client.get('/applications'),
        client.get('/projects'),
        client.get('/servers')
      ]);

      if (appsResult.status === 'rejected' && projectsResult.status === 'rejected') {
        const errReason = appsResult.reason?.response?.data?.message || appsResult.reason?.message || 'Failed to fetch both applications and projects from Coolify';
        return {
          success: false,
          message: `Coolify API error: ${errReason}`
        };
      }

      let rawApplications = [];
      if (appsResult.status === 'fulfilled' && Array.isArray(appsResult.value.data)) {
        rawApplications = appsResult.value.data;
      } else if (projectsResult.status === 'fulfilled' && Array.isArray(projectsResult.value.data)) {
        for (const project of projectsResult.value.data) {
          if (project.environments && Array.isArray(project.environments)) {
            for (const env of project.environments) {
              if (env.applications && Array.isArray(env.applications)) {
                for (const app of env.applications) {
                  if (app && !rawApplications.some(a => a.uuid === app.uuid)) {
                    app.projectName = project.name;
                    rawApplications.push(app);
                  }
                }
              }
            }
          }
        }
      }

      const appToProjectMap = {};
      if (projectsResult.status === 'fulfilled' && Array.isArray(projectsResult.value.data)) {
        for (const project of projectsResult.value.data) {
          const projectName = project.name;
          if (project.environments && Array.isArray(project.environments)) {
            for (const env of project.environments) {
              if (env.applications && Array.isArray(env.applications)) {
                for (const app of env.applications) {
                  if (app && app.uuid) {
                    appToProjectMap[app.uuid] = projectName;
                  }
                }
              }
            }
          }
        }
      }

      const normalized = rawApplications.map(app => {
        let fqdn = app.fqdn || app.domains || '';
        let firstUrl = '';
        if (fqdn) {
          firstUrl = fqdn.split(',')[0].trim();
          if (firstUrl) {
            if (!/^https?:\/\//i.test(firstUrl)) {
              firstUrl = 'https://' + firstUrl;
            }
          }
        }

        const projectName = app.projectName ||
                            app.project?.name ||
                            app.environment?.project?.name ||
                            appToProjectMap[app.uuid] ||
                            '';

        return {
          name: app.name || 'Unnamed Application',
          uuid: app.uuid || '',
          fqdn: firstUrl,
          status: app.status || 'unknown',
          projectName: projectName
        };
      });

      const raw = (appsResult.status === 'fulfilled' ? appsResult.value.data : null) ||
                  (projectsResult.status === 'fulfilled' ? projectsResult.value.data : null) ||
                  (serversResult.status === 'fulfilled' ? serversResult.value.data : null);

      const projects = projectsResult.status === 'fulfilled' ? projectsResult.value.data : null;
      const servers = serversResult.status === 'fulfilled' ? serversResult.value.data : null;

      return {
        success: true,
        resources: {
          applications: normalized,
          projects,
          servers,
          raw
        }
      };
    } catch (error) {
      return {
        success: false,
        message: `Coolify API error: ${error.message}`
      };
    }
  }

  return { success: false, message: `Unsupported provider: ${provider}` };
}

async function getCoolifyApplications(tenantId) {
  const client = await getCoolifyClient(tenantId);
  if (!client) {
    return { success: false, message: 'Coolify credentials are unset' };
  }
  try {
    const [appsResult, projectsResult, serversResult] = await Promise.allSettled([
      client.get('/applications'),
      client.get('/projects'),
      client.get('/servers')
    ]);

    if (appsResult.status === 'rejected' && projectsResult.status === 'rejected') {
      const errReason = appsResult.reason?.response?.data?.message || appsResult.reason?.message || 'Failed to fetch both applications and projects from Coolify';
      return {
        success: false,
        message: `Coolify API error: ${errReason}`
      };
    }

    let rawApplications = [];
    if (appsResult.status === 'fulfilled' && Array.isArray(appsResult.value.data)) {
      rawApplications = appsResult.value.data;
    } else if (projectsResult.status === 'fulfilled' && Array.isArray(projectsResult.value.data)) {
      for (const project of projectsResult.value.data) {
        if (project.environments && Array.isArray(project.environments)) {
          for (const env of project.environments) {
            if (env.applications && Array.isArray(env.applications)) {
              for (const app of env.applications) {
                if (app && !rawApplications.some(a => a.uuid === app.uuid)) {
                  app.projectName = project.name;
                  rawApplications.push(app);
                }
              }
            }
          }
        }
      }
    }

    const appToProjectMap = {};
    if (projectsResult.status === 'fulfilled' && Array.isArray(projectsResult.value.data)) {
      for (const project of projectsResult.value.data) {
        const projectName = project.name;
        if (project.environments && Array.isArray(project.environments)) {
          for (const env of project.environments) {
            if (env.applications && Array.isArray(env.applications)) {
              for (const app of env.applications) {
                if (app && app.uuid) {
                  appToProjectMap[app.uuid] = projectName;
                }
              }
            }
          }
        }
      }
    }

    const normalized = rawApplications.map(app => {
      let fqdn = app.fqdn || app.domains || '';
      let firstUrl = '';
      if (fqdn) {
        firstUrl = fqdn.split(',')[0].trim();
        if (firstUrl) {
          if (!/^https?:\/\//i.test(firstUrl)) {
            firstUrl = 'https://' + firstUrl;
          }
        }
      }

      return {
        name: app.name || 'Unnamed Application',
        fqdn: firstUrl || null,
        status: app.status || 'unknown'
      };
    }).filter(app => app.fqdn !== null);

    return {
      success: true,
      applications: normalized
    };
  } catch (error) {
    return {
      success: false,
      message: `Coolify API error: ${error.message}`
    };
  }
}

module.exports = {
  listProviderResources,
  getCoolifyApplications
};
