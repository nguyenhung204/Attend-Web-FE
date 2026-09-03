import { Component, HostListener } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'FE_attendance';
  pullDistance = 0;
  isRefreshing = false;
  private pullStartY?: number;
  private canPullToRefresh = false;
  private readonly refreshThreshold = 76;

  constructor(private readonly updates: SwUpdate) {}

  get pullIndicatorOffset(): number {
    return this.isRefreshing ? 12 : Math.min(this.pullDistance, this.refreshThreshold) - 60;
  }

  @HostListener('window:touchstart', ['$event'])
  onTouchStart(event: TouchEvent): void {
    if (this.isRefreshing || event.touches.length !== 1) return;
    this.pullStartY = event.touches[0].clientY;
    this.canPullToRefresh = this.isAtTop(event.target);
  }

  @HostListener('window:touchmove', ['$event'])
  onTouchMove(event: TouchEvent): void {
    if (!this.canPullToRefresh || this.pullStartY === undefined || event.touches.length !== 1) return;
    const distance = event.touches[0].clientY - this.pullStartY;
    if (distance <= 0) {
      this.pullDistance = 0;
      return;
    }
    event.preventDefault();
    this.pullDistance = Math.min(distance * .45, this.refreshThreshold + 28);
  }

  @HostListener('window:touchend')
  onTouchEnd(): void {
    const shouldRefresh = this.pullDistance >= this.refreshThreshold;
    this.pullStartY = undefined;
    this.canPullToRefresh = false;
    this.pullDistance = 0;
    if (shouldRefresh) void this.syncAndReload();
  }

  @HostListener('window:touchcancel')
  onTouchCancel(): void {
    this.pullStartY = undefined;
    this.canPullToRefresh = false;
    this.pullDistance = 0;
  }

  private isAtTop(target: EventTarget | null): boolean {
    let element = target instanceof HTMLElement ? target : null;
    while (element && element !== document.body) {
      const style = window.getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY)) return element.scrollTop <= 0;
      element = element.parentElement;
    }
    return window.scrollY <= 0;
  }

  private async syncAndReload(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      if (this.updates.isEnabled) {
        const hasUpdate = await this.updates.checkForUpdate();
        if (hasUpdate) await this.updates.activateUpdate();
      }
    } finally {
      window.location.reload();
    }
  }
}
