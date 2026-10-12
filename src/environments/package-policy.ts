export const PACKAGE_NAME=/^[a-z0-9][a-z0-9+.-]{1,63}$/;
export const validPackage=(name:unknown):name is string=>typeof name==='string'&&PACKAGE_NAME.test(name);
