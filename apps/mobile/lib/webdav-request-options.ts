export const getMobileWebDavRequestOptions = (allowInsecureHttp?: boolean) => (
  allowInsecureHttp === true ? { allowInsecureHttp: true } : {}
);

export const getMobileCloudRequestOptions = (allowInsecureHttp?: boolean) => (
  allowInsecureHttp === true ? { allowInsecureHttp: true } : {}
);
