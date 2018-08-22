declare module 'dojot-iotagent' {
  export class IoTAgent {
    constructor (config?: any);

    init(): void;

    getDevice(deviceid: string, tenant: string): Promise<any>;
    listDevices(tenant: string, query?: any): Promise<any>;
    listTenants(): Promise<any>;

    on(event:string, callback:(data?:any) => void): void;

    updateAttrs(deviceid:string, tenant:string, attrs:any, metadata?:any): void;

    on(event:string, callback:() => void): void;
    setOnline(deviceid: string, tenant:string, expires:Date): void;
    setOffline(deviceid: string, tenant:string): void;
  }
}
