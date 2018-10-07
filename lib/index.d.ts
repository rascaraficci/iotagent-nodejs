declare module 'dojot-iotagent' {
  export class IoTAgent {
    constructor ();

    init(): Promise<any>;;

    getDevice(deviceid: string, tenant: string): Promise<any>;
    
    updateAttrs(deviceid:string, tenant:string, attrs:any, metadata?:any): void;

    setOnline(deviceid: string, tenant:string, expires:Date): void;
    setOffline(deviceid: string, tenant:string): void;
  }
}
