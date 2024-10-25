import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class HttpService {

  private apiUrl = 'http://localhost:5000/google-sheets/mssv'; // Thay thế bằng URL API của bạn

  constructor(private http: HttpClient) { }

  getData(): Observable<any> {
    console.log('Getting data from API');
    return this.http.get(`${this.apiUrl}`);
  }

}