import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class HttpService {

  private apiUrl = 'http://172.16.10.164:5000/google-sheets'; // Thay thế bằng URL API của bạn

  constructor(private http: HttpClient) { }

  async getData(): Promise<Observable<any>> {
    console.log('Getting data from API');
    return this.http.get(`${this.apiUrl}/mssv`);
  }
  async attendData(): Promise<Observable<any>> {
    return this.http.get(`${this.apiUrl}/attendance-list`);
  }

}
