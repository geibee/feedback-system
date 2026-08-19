targetScope = 'resourceGroup'

@description('短い英小文字・数字・hyphenで構成するFeedback resource prefix。')
@minLength(3)
@maxLength(8)
param resourcePrefix string

param location string = resourceGroup().location
param containerAppsEnvironmentName string
param containerAppsEnvironmentResourceGroupName string
param containerAppsEnvironmentSubscriptionId string = subscription().subscriptionId
param acrName string
param acrResourceGroupName string
param acrSubscriptionId string = subscription().subscriptionId
param postgresDelegatedSubnetResourceId string
param postgresPrivateDnsZoneResourceId string
param privateEndpointSubnetResourceId string
param blobPrivateDnsZoneResourceId string
param vaultPrivateDnsZoneResourceId string

@secure()
param databasePassword string

@secure()
param notificationEncryptionKey string

param databaseAdministratorLogin string = 'feedback_admin'
param oidcIssuer string
param oidcAudience string
param oidcJwksUrl string
param tokenExchangeIssuer string = ''
param tokenExchangeAudience string = ''
param tokenExchangeJwksUrl string = ''
param tokenExchangeActorIssuers string = ''
param serviceImage string
param adminImage string
param adminEnabled bool = true
param runtimeEnabled bool = false
param bootstrapEnabled bool = false
param bootstrapTenantKey string = ''
param bootstrapTenantDisplayName string = ''
param bootstrapApplicationKey string = ''
param bootstrapApplicationDisplayName string = ''
param bootstrapEnvironmentKey string = ''
param bootstrapEnvironmentBaseUrl string = ''
param bootstrapAllowedOrigins string = ''
param bootstrapExternalWorkspaceKey string = ''
param bootstrapWorkspaceDisplayName string = ''
param bootstrapIssuer string = ''
param bootstrapSubject string = ''
param bootstrapEmail string = ''
param bootstrapDisplayName string = ''
param bootstrapPermissions string = ''

var suffix = substring(uniqueString(resourceGroup().id), 0, 6)
var storageName = '${replace(resourcePrefix, '-', '')}st${suffix}'
var keyVaultName = '${resourcePrefix}-kv-${suffix}'
var postgresName = '${resourcePrefix}-pg-${suffix}'
var blobAccountUrl = 'https://${storageName}.blob.${environment().suffixes.storage}'
var databaseUrl = 'jdbc:postgresql://${postgresName}.postgres.database.azure.com:5432/feedback?sslmode=require'
var blobContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var blobReaderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
var keyVaultSecretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: containerAppsEnvironmentName
  scope: resourceGroup(containerAppsEnvironmentSubscriptionId, containerAppsEnvironmentResourceGroupName)
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
  scope: resourceGroup(acrSubscriptionId, acrResourceGroupName)
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: location
  sku: {
    name: 'Standard_D2ds_v5'
    tier: 'GeneralPurpose'
  }
  properties: {
    version: '16'
    administratorLogin: databaseAdministratorLogin
    administratorLoginPassword: databasePassword
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    backup: {
      backupRetentionDays: 14
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'ZoneRedundant'
    }
    network: {
      delegatedSubnetResourceId: postgresDelegatedSubnetResourceId
      privateDnsZoneArmResourceId: postgresPrivateDnsZoneResourceId
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      autoGrow: 'Enabled'
      storageSizeGB: 128
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'feedback'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_ZRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 14
    }
    deleteRetentionPolicy: {
      enabled: true
      days: 14
    }
  }
}

resource evidenceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'feedback-evidence'
  properties: {
    publicAccess: 'None'
  }
}

resource exportContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'feedback-exports'
  properties: {
    publicAccess: 'None'
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    enablePurgeProtection: true
    enableRbacAuthorization: true
    publicNetworkAccess: 'Disabled'
    softDeleteRetentionInDays: 90
    sku: {
      family: 'A'
      name: 'standard'
    }
  }
}

resource databasePasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'feedback-database-password'
  properties: {
    value: databasePassword
  }
}

resource notificationKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'feedback-notification-encryption-key'
  properties: {
    value: notificationEncryptionKey
  }
}

resource storagePrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${resourcePrefix}-blob-pe'
  location: location
  properties: {
    subnet: {
      id: privateEndpointSubnetResourceId
    }
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: {
          groupIds: [
            'blob'
          ]
          privateLinkServiceId: storage.id
        }
      }
    ]
  }
}

resource storagePrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: storagePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: blobPrivateDnsZoneResourceId
        }
      }
    ]
  }
}

resource vaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${resourcePrefix}-vault-pe'
  location: location
  properties: {
    subnet: {
      id: privateEndpointSubnetResourceId
    }
    privateLinkServiceConnections: [
      {
        name: 'vault'
        properties: {
          groupIds: [
            'vault'
          ]
          privateLinkServiceId: vault.id
        }
      }
    ]
  }
}

resource vaultPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: vaultPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: {
          privateDnsZoneId: vaultPrivateDnsZoneResourceId
        }
      }
    ]
  }
}

resource imagePullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${resourcePrefix}-pull-id'
  location: location
}

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${resourcePrefix}-api-id'
  location: location
}

resource exportIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${resourcePrefix}-export-id'
  location: location
}

resource retentionIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${resourcePrefix}-retention-id'
  location: location
}

resource notificationIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${resourcePrefix}-notification-id'
  location: location
}

resource migrationIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${resourcePrefix}-migration-id'
  location: location
}

module acrPullAssignment './acr-pull.bicep' = {
  name: 'feedback-acr-pull'
  scope: resourceGroup(acrSubscriptionId, acrResourceGroupName)
  params: {
    acrName: acrName
    principalId: imagePullIdentity.properties.principalId
    principalResourceId: imagePullIdentity.id
  }
}

resource apiEvidenceContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(evidenceContainer.id, apiIdentity.id, blobContributorRoleId)
  scope: evidenceContainer
  properties: {
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobContributorRoleId
  }
}

resource apiExportReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(exportContainer.id, apiIdentity.id, blobReaderRoleId)
  scope: exportContainer
  properties: {
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobReaderRoleId
  }
}

resource exportEvidenceReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(evidenceContainer.id, exportIdentity.id, blobReaderRoleId)
  scope: evidenceContainer
  properties: {
    principalId: exportIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobReaderRoleId
  }
}

resource exportOutputContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(exportContainer.id, exportIdentity.id, blobContributorRoleId)
  scope: exportContainer
  properties: {
    principalId: exportIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobContributorRoleId
  }
}

resource retentionEvidenceContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(evidenceContainer.id, retentionIdentity.id, blobContributorRoleId)
  scope: evidenceContainer
  properties: {
    principalId: retentionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobContributorRoleId
  }
}

resource retentionExportContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(exportContainer.id, retentionIdentity.id, blobContributorRoleId)
  scope: exportContainer
  properties: {
    principalId: retentionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobContributorRoleId
  }
}

resource apiKeyVaultSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, apiIdentity.id, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleId
  }
}

resource exportKeyVaultSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, exportIdentity.id, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    principalId: exportIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleId
  }
}

resource retentionKeyVaultSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, retentionIdentity.id, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    principalId: retentionIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleId
  }
}

resource notificationKeyVaultSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, notificationIdentity.id, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    principalId: notificationIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleId
  }
}

resource migrationKeyVaultSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, migrationIdentity.id, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    principalId: migrationIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleId
  }
}

module workloads './workloads.bicep' = {
  name: 'feedback-workloads'
  params: {
    resourcePrefix: resourcePrefix
    location: location
    containerAppsEnvironmentId: containerAppsEnvironment.id
    acrLoginServer: acr.properties.loginServer
    imagePullIdentityResourceId: imagePullIdentity.id
    serviceImage: serviceImage
    adminImage: adminImage
    adminEnabled: adminEnabled
    runtimeEnabled: runtimeEnabled
    apiIdentityResourceId: apiIdentity.id
    apiIdentityClientId: apiIdentity.properties.clientId
    exportIdentityResourceId: exportIdentity.id
    exportIdentityClientId: exportIdentity.properties.clientId
    retentionIdentityResourceId: retentionIdentity.id
    retentionIdentityClientId: retentionIdentity.properties.clientId
    notificationIdentityResourceId: notificationIdentity.id
    migrationIdentityResourceId: migrationIdentity.id
    databaseUrl: databaseUrl
    databaseUser: databaseAdministratorLogin
    databasePasswordSecretUrl: databasePasswordSecret.properties.secretUriWithVersion
    notificationEncryptionKeySecretUrl: notificationKeySecret.properties.secretUriWithVersion
    blobAccountUrl: blobAccountUrl
    evidenceContainer: evidenceContainer.name
    exportContainer: exportContainer.name
    oidcIssuer: oidcIssuer
    oidcAudience: oidcAudience
    oidcJwksUrl: oidcJwksUrl
    tokenExchangeIssuer: tokenExchangeIssuer
    tokenExchangeAudience: tokenExchangeAudience
    tokenExchangeJwksUrl: tokenExchangeJwksUrl
    tokenExchangeActorIssuers: tokenExchangeActorIssuers
    bootstrapEnabled: bootstrapEnabled
    bootstrapTenantKey: bootstrapTenantKey
    bootstrapTenantDisplayName: bootstrapTenantDisplayName
    bootstrapApplicationKey: bootstrapApplicationKey
    bootstrapApplicationDisplayName: bootstrapApplicationDisplayName
    bootstrapEnvironmentKey: bootstrapEnvironmentKey
    bootstrapEnvironmentBaseUrl: bootstrapEnvironmentBaseUrl
    bootstrapAllowedOrigins: bootstrapAllowedOrigins
    bootstrapExternalWorkspaceKey: bootstrapExternalWorkspaceKey
    bootstrapWorkspaceDisplayName: bootstrapWorkspaceDisplayName
    bootstrapIssuer: bootstrapIssuer
    bootstrapSubject: bootstrapSubject
    bootstrapEmail: bootstrapEmail
    bootstrapDisplayName: bootstrapDisplayName
    bootstrapPermissions: bootstrapPermissions
  }
  dependsOn: [
    acrPullAssignment
    apiEvidenceContributor
    apiExportReader
    exportEvidenceReader
    exportOutputContributor
    retentionEvidenceContributor
    retentionExportContributor
    apiKeyVaultSecretReader
    exportKeyVaultSecretReader
    retentionKeyVaultSecretReader
    notificationKeyVaultSecretReader
    migrationKeyVaultSecretReader
    database
    storagePrivateDnsGroup
    vaultPrivateDnsGroup
  ]
}

output apiContainerAppId string = workloads.outputs.apiContainerAppId
output apiFqdn string = workloads.outputs.apiFqdn
output adminContainerAppId string = workloads.outputs.adminContainerAppId
output adminFqdn string = workloads.outputs.adminFqdn
output migrationJobName string = workloads.outputs.migrationJobName
output bootstrapJobName string = workloads.outputs.bootstrapJobName
output storageAccountName string = storage.name
output postgresServerName string = postgres.name
output keyVaultName string = vault.name
