const extensionApi = globalThis.browser ?? globalThis.chrome;

function getStorageArea(areaName) {
    const area = extensionApi?.storage?.[areaName];
    if (!area) {
        throw new Error(`Storage area is unavailable: ${areaName}`);
    }
    return area;
}

function callStorageMethod(areaName, methodName, ...args) {
    const area = getStorageArea(areaName);
    if (globalThis.browser) {
        return Promise.resolve(area[methodName](...args));
    }

    return new Promise((resolve, reject) => {
        const onSuccess = (value) => {
            const error = extensionApi?.runtime?.lastError;
            if (error) {
                reject(new Error(error.message));
                return;
            }
            resolve(value);
        };

        try {
            area[methodName](...args, onSuccess);
        } catch (error) {
            reject(error);
        }
    });
}

export const extensionStorage = {
    get: (areaName, keys) => callStorageMethod(areaName, 'get', keys),
    set: (areaName, values) => callStorageMethod(areaName, 'set', values),
    remove: (areaName, keys) => callStorageMethod(areaName, 'remove', keys)
};
