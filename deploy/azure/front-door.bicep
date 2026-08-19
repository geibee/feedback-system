targetScope = 'resourceGroup'

@description('既存Azure Front Door Premium profile。')
param frontDoorProfileName string

@description('既存Azure Front Door endpoint。')
param frontDoorEndpointName string

@description('Feedback API Container AppのFQDN。')
param apiOriginHostName string

@description('Feedback API Container Appのresource ID。')
param apiContainerAppId string

@description('Container Apps managed environmentのresource ID。Private Linkの接続先に使用する。')
param containerAppsEnvironmentId string

param containerAppsLocation string

@description('既存Front Door custom domain resource ID。少なくとも1件指定する。')
param customDomainIds array

param adminEnabled bool = false
param adminOriginHostName string = ''
param adminContainerAppId string = ''

@description('Admin専用hostnameに対応する既存Front Door custom domain resource ID。')
param adminCustomDomainIds array = []

resource profile 'Microsoft.Cdn/profiles@2024-02-01' existing = {
  name: frontDoorProfileName
}

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' existing = {
  parent: profile
  name: frontDoorEndpointName
}

resource apiOriginGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: profile
  name: 'feedback-api'
  properties: {
    healthProbeSettings: {
      probeIntervalInSeconds: 30
      probePath: '/health/ready'
      probeProtocol: 'Https'
      probeRequestType: 'GET'
    }
    loadBalancingSettings: {
      additionalLatencyInMilliseconds: 0
      sampleSize: 4
      successfulSamplesRequired: 3
    }
    sessionAffinityState: 'Disabled'
    trafficRestorationTimeToHealedOrNewEndpointsInMinutes: 10
  }
}

resource apiOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: apiOriginGroup
  name: 'feedback-api'
  properties: {
    azureOrigin: {
      id: apiContainerAppId
    }
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
    hostName: apiOriginHostName
    httpPort: 80
    httpsPort: 443
    originHostHeader: apiOriginHostName
    priority: 1
    sharedPrivateLinkResource: {
      groupId: 'managedEnvironments'
      privateLink: {
        id: containerAppsEnvironmentId
      }
      privateLinkLocation: containerAppsLocation
      requestMessage: 'Feedback API用Azure Front Door Private Link'
      status: 'Pending'
    }
    weight: 1000
  }
}

resource apiRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: endpoint
  name: 'feedback-api'
  properties: {
    customDomains: [for domainId in customDomainIds: {
      id: domainId
    }]
    enabledState: 'Enabled'
    forwardingProtocol: 'HttpsOnly'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Disabled'
    originGroup: {
      id: apiOriginGroup.id
    }
    patternsToMatch: [
      '/feedback/v1/*'
    ]
    supportedProtocols: [
      'Https'
    ]
  }
  dependsOn: [
    apiOrigin
  ]
}

resource adminOriginGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = if (adminEnabled) {
  parent: profile
  name: 'feedback-admin'
  properties: {
    healthProbeSettings: {
      probeIntervalInSeconds: 30
      probePath: '/'
      probeProtocol: 'Https'
      probeRequestType: 'GET'
    }
    loadBalancingSettings: {
      additionalLatencyInMilliseconds: 0
      sampleSize: 4
      successfulSamplesRequired: 3
    }
    sessionAffinityState: 'Disabled'
    trafficRestorationTimeToHealedOrNewEndpointsInMinutes: 10
  }
}

resource adminOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = if (adminEnabled) {
  parent: adminOriginGroup
  name: 'feedback-admin'
  properties: {
    azureOrigin: {
      id: adminContainerAppId
    }
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
    hostName: adminOriginHostName
    httpPort: 80
    httpsPort: 443
    originHostHeader: adminOriginHostName
    priority: 1
    sharedPrivateLinkResource: {
      groupId: 'managedEnvironments'
      privateLink: {
        id: containerAppsEnvironmentId
      }
      privateLinkLocation: containerAppsLocation
      requestMessage: 'Feedback Admin用Azure Front Door Private Link'
      status: 'Pending'
    }
    weight: 1000
  }
}

resource adminRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = if (adminEnabled) {
  parent: endpoint
  name: 'feedback-admin'
  properties: {
    customDomains: [for domainId in adminCustomDomainIds: {
      id: domainId
    }]
    enabledState: 'Enabled'
    forwardingProtocol: 'HttpsOnly'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Disabled'
    originGroup: {
      id: adminOriginGroup.id
    }
    patternsToMatch: [
      '/*'
    ]
    supportedProtocols: [
      'Https'
    ]
  }
  dependsOn: [
    adminOrigin
  ]
}

output originGroupId string = apiOriginGroup.id
output routeId string = apiRoute.id
output adminRouteId string = adminEnabled ? adminRoute!.id : ''
