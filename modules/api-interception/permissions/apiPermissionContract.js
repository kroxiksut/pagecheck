export const API_PERMISSION_DESCRIPTOR = Object.freeze({
    permissions: Object.freeze(['webRequest']),
    origins: Object.freeze(['http://*/*', 'https://*/*'])
});

export const API_PERMISSION_MODULE_ID = 'Api-Interceptor';

export function isApiPermissionDescriptorRelevant(permissionChange) {
    if (!permissionChange || typeof permissionChange !== 'object') {
        return false;
    }
    const permissions = Array.isArray(permissionChange.permissions) ? permissionChange.permissions : [];
    const origins = Array.isArray(permissionChange.origins) ? permissionChange.origins : [];
    return permissions.includes('webRequest')
        || origins.includes('http://*/*')
        || origins.includes('https://*/*');
}
