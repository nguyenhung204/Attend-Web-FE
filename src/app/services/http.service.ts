import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, tap } from 'rxjs';


export interface DataService {
  getData(): Promise<Observable<any>>;
}

export interface AttendanceService {
  attendData(): Promise<Observable<any>>;
}

@Injectable({
  providedIn: 'root'
})
export class HttpService implements DataService, AttendanceService {

  private apiUrl = 'https://bancongnghe.click/google-sheets'; // Thay thế bằng URL API của bạn

  private cache = {
    mssvData: null as any,
    attendanceData: null as any,
    lastFetch: {
      mssv: 0,
      attendance: 0
    }
  };
  private CACHE_DURATION = 10 * 60 * 1000; // 30 phút

  constructor(private http: HttpClient) { }

  async getData(): Promise<Observable<any>> {
    // Kiểm tra cache
    if (this.isCacheValid('mssv')) {
      console.log('Getting data from cache');
      return of(this.cache.mssvData);
    }

    console.log('Getting data from API');
    return this.http.get(`${this.apiUrl}/mssv`).pipe(
      tap(data => {
        this.cache.mssvData = data;
        this.cache.lastFetch.mssv = Date.now();
      })
    );
  }
  async attendData(): Promise<Observable<any>> {
    if (this.isCacheValid('attendance')) {
      console.log('Getting attendance data from cache');
      return of(this.cache.attendanceData);
    }

    return this.http.get(`${this.apiUrl}/attendance-list`).pipe(
      tap(data => {
        this.cache.attendanceData = data;
        this.cache.lastFetch.attendance = Date.now();
      })
    );
  }
  private isCacheValid(type: 'mssv' | 'attendance'): boolean {
    const data = type === 'mssv' ? this.cache.mssvData : this.cache.attendanceData;
    const lastFetch = this.cache.lastFetch[type];
    return data !== null && Date.now() - lastFetch < this.CACHE_DURATION;
  }


  clearCache(): void {
    this.cache = {
      mssvData: null,
      attendanceData: null,
      lastFetch: {
        mssv: 0,
        attendance: 0
      }
    };
  }



}
