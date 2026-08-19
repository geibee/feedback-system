targetScope = 'resourceGroup'

param resourcePrefix string
param location string
param containerAppsEnvironmentId string
param acrLoginServer string
param imagePullIdentityResourceId string
param serviceImage string
param adminImage string
param adminEnabled bool
param runtimeEnabled bool
param apiIdentityResourceId string
param apiIdentityClientId string
param exportIdentityResourceId string
param exportIdentityClientId string
param retentionIdentityResourceId string
param retentionIdentityClientId string
param notificationIdentityResourceId string
param migrationIdentityResourceId string
param databaseUrl string
param databaseUser string
param databasePasswordSecretUrl string
param notificationEncryptionKeySecretUrl string
param blobAccountUrl string
param evidenceContainer string
param exportContainer string
param oidcIssuer string
param oidcAudience string
param oidcJwksUrl string
param tokenExchangeIssuer string
param tokenExchangeAudience string
param tokenExchangeJwksUrl string
param tokenExchangeActorIssuers string
param bootstrapEnabled bool
param bootstrapTenantKey string
param bootstrapTenantDisplayName string
param bootstrapApplicationKey string
param bootstrapApplicationDisplayName string
param bootstrapEnvironmentKey string
param bootstrapEnvironmentBaseUrl string
param bootstrapAllowedOrigins string
param bootstrapExternalWorkspaceKey string
param bootstrapWorkspaceDisplayName string
param bootstrapIssuer string
param bootstrapSubject string
param bootstrapEmail string
param bootstrapDisplayName string
param bootstrapPermissions string

var resourceLimits = {
  cpu: json('1.0')
  memory: '0.5Gi'
}
var databaseEnvironment = [
  {
    name: 'FEEDBACK_DATABASE_URL'
    value: databaseUrl
  }
  {
    name: 'FEEDBACK_DATABASE_USER'
    value: databaseUser
  }
  {
    name: 'FEEDBACK_DATABASE_PASSWORD'
    secretRef: 'database-password'
  }
]
var tokenExchangeEnvironment = empty(tokenExchangeIssuer) ? [] : [
  {
    name: 'FEEDBACK_TOKEN_EXCHANGE_ISSUER'
    value: tokenExchangeIssuer
  }
  {
    name: 'FEEDBACK_TOKEN_EXCHANGE_AUDIENCE'
    value: tokenExchangeAudience
  }
  {
    name: 'FEEDBACK_TOKEN_EXCHANGE_JWKS_URL'
    value: tokenExchangeJwksUrl
  }
  {
    name: 'FEEDBACK_TOKEN_EXCHANGE_ACTOR_ISSUERS'
    value: tokenExchangeActorIssuers
  }
]
var evidenceEnvironment = [
  {
    name: 'FEEDBACK_EVIDENCE_STORAGE'
    value: 'azure_blob'
  }
  {
    name: 'FEEDBACK_AZURE_BLOB_ACCOUNT_URL'
    value: blobAccountUrl
  }
  {
    name: 'FEEDBACK_AZURE_BLOB_CONTAINER'
    value: evidenceContainer
  }
  {
    name: 'FEEDBACK_AZURE_BLOB_KEY_PREFIX'
    value: 'evidence/'
  }
]
var exportEnvironment = [
  {
    name: 'FEEDBACK_EXPORT_STORAGE'
    value: 'azure_blob'
  }
  {
    name: 'FEEDBACK_EXPORT_AZURE_BLOB_ACCOUNT_URL'
    value: blobAccountUrl
  }
  {
    name: 'FEEDBACK_EXPORT_AZURE_BLOB_CONTAINER'
    value: exportContainer
  }
  {
    name: 'FEEDBACK_EXPORT_AZURE_BLOB_KEY_PREFIX'
    value: 'exports/'
  }
]

resource api 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${resourcePrefix}-api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${imagePullIdentityResourceId}': {}
      '${apiIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 8090
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        transport: 'http'
      }
      registries: [
        {
          identity: imagePullIdentityResourceId
          server: acrLoginServer
        }
      ]
      secrets: [
        {
          identity: apiIdentityResourceId
          keyVaultUrl: databasePasswordSecretUrl
          name: 'database-password'
        }
        {
          identity: apiIdentityResourceId
          keyVaultUrl: notificationEncryptionKeySecretUrl
          name: 'notification-encryption-key'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'feedback-api'
          image: serviceImage
          command: [
            '/app/bin/feedback-service'
          ]
          env: concat(databaseEnvironment, evidenceEnvironment, exportEnvironment, tokenExchangeEnvironment, [
            {
              name: 'AZURE_CLIENT_ID'
              value: apiIdentityClientId
            }
            {
              name: 'FEEDBACK_NOTIFICATION_ENCRYPTION_KEY'
              secretRef: 'notification-encryption-key'
            }
            {
              name: 'FEEDBACK_OIDC_ISSUER'
              value: oidcIssuer
            }
            {
              name: 'FEEDBACK_OIDC_AUDIENCE'
              value: oidcAudience
            }
            {
              name: 'FEEDBACK_OIDC_JWKS_URL'
              value: oidcJwksUrl
            }
            {
              name: 'FEEDBACK_PORT'
              value: '8090'
            }
          ])
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health/live'
                port: 8090
                scheme: 'HTTP'
              }
              failureThreshold: 30
              periodSeconds: 2
              timeoutSeconds: 2
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 8090
                scheme: 'HTTP'
              }
              failureThreshold: 3
              periodSeconds: 10
              timeoutSeconds: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8090
                scheme: 'HTTP'
              }
              failureThreshold: 3
              periodSeconds: 10
              timeoutSeconds: 5
            }
          ]
          resources: resourceLimits
        }
      ]
      scale: {
        minReplicas: runtimeEnabled ? 2 : 0
        maxReplicas: 4
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
      terminationGracePeriodSeconds: 30
    }
  }
}

resource admin 'Microsoft.App/containerApps@2025-01-01' = if (adminEnabled) {
  name: '${resourcePrefix}-admin'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${imagePullIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 80
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        transport: 'http'
      }
      registries: [
        {
          identity: imagePullIdentityResourceId
          server: acrLoginServer
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'feedback-admin'
          image: adminImage
          resources: resourceLimits
        }
      ]
      scale: {
        minReplicas: runtimeEnabled ? 1 : 0
        maxReplicas: 2
      }
    }
  }
}

resource exportWorker 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${resourcePrefix}-export'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${imagePullIdentityResourceId}': {}
      '${exportIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          identity: imagePullIdentityResourceId
          server: acrLoginServer
        }
      ]
      secrets: [
        {
          identity: exportIdentityResourceId
          keyVaultUrl: databasePasswordSecretUrl
          name: 'database-password'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'feedback-export-worker'
          image: serviceImage
          command: [
            '/app/bin/feedback-export-worker'
          ]
          env: concat(databaseEnvironment, evidenceEnvironment, exportEnvironment, [
            {
              name: 'AZURE_CLIENT_ID'
              value: exportIdentityClientId
            }
          ])
          resources: resourceLimits
        }
      ]
      scale: {
        minReplicas: runtimeEnabled ? 1 : 0
        maxReplicas: 1
      }
      terminationGracePeriodSeconds: 30
    }
  }
}

resource retentionWorker 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${resourcePrefix}-retention'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${imagePullIdentityResourceId}': {}
      '${retentionIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          identity: imagePullIdentityResourceId
          server: acrLoginServer
        }
      ]
      secrets: [
        {
          identity: retentionIdentityResourceId
          keyVaultUrl: databasePasswordSecretUrl
          name: 'database-password'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'feedback-retention-worker'
          image: serviceImage
          command: [
            '/app/bin/feedback-retention-worker'
          ]
          env: concat(databaseEnvironment, evidenceEnvironment, exportEnvironment, [
            {
              name: 'AZURE_CLIENT_ID'
              value: retentionIdentityClientId
            }
          ])
          resources: resourceLimits
        }
      ]
      scale: {
        minReplicas: runtimeEnabled ? 1 : 0
        maxReplicas: 1
      }
      terminationGracePeriodSeconds: 30
    }
  }
}

resource notificationWorker 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${resourcePrefix}-notification'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${imagePullIdentityResourceId}': {}
      '${notificationIdentityResourceId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          identity: imagePullIdentityResourceId
          server: acrLoginServer
        }
      ]
      secrets: [
        {
          identity: notificationIdentityResourceId
          keyVaultUrl: databasePasswordSecretUrl
          name: 'database-password'
        }
        {
          identity: notificationIdentityResourceId
          keyVaultUrl: notificationEncryptionKeySecretUrl
          name: 'notification-encryption-key'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'feedback-notification-worker'
          image: serviceImage
          command: [
            '/app/bin/feedback-notification-worker'
          ]
          env: concat(databaseEnvironment, [
            {
              name: 'FEEDBACK_NOTIFICATION_ENCRYPTION_KEY'
              secretRef: 'notification-encryption-key'
            }
          ])
          resources: resourceLimits
        }
      ]
      scale: {
        minReplicas: runtimeEnabled ? 1 : 0
        maxReplicas: 1
      }
      terminationGracePeriodSeconds: 30
    }
  }
}

resource migrationJob 'Microsoft.App/jobs@2025-01-01' = {
  name: '${resourcePrefix}-migrate'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${imagePullIdentityResourceId}': {}
      '${migrationIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironmentId
    configuration: {
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          identity: imagePullIdentityResourceId
          server: acrLoginServer
        }
      ]
      replicaRetryLimit: 0
      replicaTimeout: 1800
      secrets: [
        {
          identity: migrationIdentityResourceId
          keyVaultUrl: databasePasswordSecretUrl
          name: 'database-password'
        }
      ]
      triggerType: 'Manual'
    }
    template: {
      containers: [
        {
          name: 'feedback-migrate'
          image: serviceImage
          command: [
            '/app/bin/feedback-migrate'
          ]
          env: databaseEnvironment
          resources: resourceLimits
        }
      ]
    }
  }
}

resource bootstrapJob 'Microsoft.App/jobs@2025-01-01' = if (bootstrapEnabled) {
  name: '${resourcePrefix}-bootstrap'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${imagePullIdentityResourceId}': {}
      '${migrationIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironmentId
    configuration: {
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          identity: imagePullIdentityResourceId
          server: acrLoginServer
        }
      ]
      replicaRetryLimit: 0
      replicaTimeout: 600
      secrets: [
        {
          identity: migrationIdentityResourceId
          keyVaultUrl: databasePasswordSecretUrl
          name: 'database-password'
        }
      ]
      triggerType: 'Manual'
    }
    template: {
      containers: [
        {
          name: 'feedback-bootstrap'
          image: serviceImage
          command: [
            '/app/bin/feedback-bootstrap'
          ]
          env: concat(databaseEnvironment, [
            {
              name: 'FEEDBACK_BOOTSTRAP_TENANT_KEY'
              value: bootstrapTenantKey
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_TENANT_DISPLAY_NAME'
              value: bootstrapTenantDisplayName
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_APPLICATION_KEY'
              value: bootstrapApplicationKey
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_APPLICATION_DISPLAY_NAME'
              value: bootstrapApplicationDisplayName
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_ENVIRONMENT_KEY'
              value: bootstrapEnvironmentKey
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_ENVIRONMENT_BASE_URL'
              value: bootstrapEnvironmentBaseUrl
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_ALLOWED_ORIGINS'
              value: bootstrapAllowedOrigins
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_EXTERNAL_WORKSPACE_KEY'
              value: bootstrapExternalWorkspaceKey
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_WORKSPACE_DISPLAY_NAME'
              value: bootstrapWorkspaceDisplayName
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_ISSUER'
              value: bootstrapIssuer
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_SUBJECT'
              value: bootstrapSubject
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_EMAIL'
              value: bootstrapEmail
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_DISPLAY_NAME'
              value: bootstrapDisplayName
            }
            {
              name: 'FEEDBACK_BOOTSTRAP_PERMISSIONS'
              value: bootstrapPermissions
            }
          ])
          resources: resourceLimits
        }
      ]
    }
  }
}

output apiContainerAppId string = api.id
output apiFqdn string = api.properties.configuration.ingress.fqdn
output adminContainerAppId string = adminEnabled ? admin!.id : ''
output adminFqdn string = adminEnabled ? admin!.properties.configuration.ingress.fqdn : ''
output migrationJobName string = migrationJob.name
output bootstrapJobName string = bootstrapEnabled ? bootstrapJob.name : ''
