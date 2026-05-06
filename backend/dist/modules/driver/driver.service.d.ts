export declare class DriverService {
    static getProfile(userId: string): Promise<any>;
    static onboard(userId: string, data: any): Promise<any>;
    static updateProfile(userId: string, data: any): Promise<any>;
    static requestVerification(userId: string, data: any): Promise<any>;
    static getVehicles(): Promise<any[]>;
}
