declare module '@dojot/iotagent-nodejs' {
  export class IoTAgent {
    constructor ();
    init(): Promise<any>;;
    getDevice(deviceid: string, tenant: string): Promise<any>;
    checkCompleteMetaFields(deviceid: string, tenant: string, metadata: any): any;
    updateAttrs(deviceid: string, tenant: string, attrs: any, metadata?: any): void;
    setOnline(deviceid: string, tenant:string, expires:Date): void;
    setOffline(deviceid: string, tenant:string): void;
    on(subject: string, event: string, callback: (tenant: string, data: any) => void): void;
  }
  
  export class UnknownDeviceError extends Error {}
  export class UnknownTenantError extends Error {}
  export class InitializationError extends Error {}
}
