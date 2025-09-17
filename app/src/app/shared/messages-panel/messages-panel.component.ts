import {ChangeDetectionStrategy, Component, OnInit, AfterViewInit, Injector, effect, inject, signal, computed, ViewChild, ElementRef} from '@angular/core';
import {CommonModule} from '@angular/common';
import {MessageEngineService, type MessageItem} from '../services/message-engine.service';

@Component({
  selector: 'app-messages-panel',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'd-block' },
  templateUrl: './messages-panel.component.html',
  styleUrl: './messages-panel.component.css',
})
export class MessagesPanelComponent implements OnInit, AfterViewInit {
  readonly engine = inject(MessageEngineService);
  private readonly injector = inject(Injector);

  // Filters
  readonly showInfo = signal<boolean>(true);
  readonly showWarn = signal<boolean>(true);
  readonly showError = signal<boolean>(true);

  readonly all = this.engine.messages;
  readonly filtered = computed<MessageItem[]>(() => {
    const a = this.all();
    if (!a.length) return a;
    const sI = this.showInfo();
    const sW = this.showWarn();
    const sE = this.showError();
    if (sI && sW && sE) return a;
    return a.filter(m => (m.category === 'info' && sI) || (m.category === 'warn' && sW) || (m.category === 'error' && sE));
  });

  // Virtualization (simple) when > 500
  private readonly ROW_H = 56; // px, keep in sync with CSS
  readonly useVirtual = computed<boolean>(() => this.filtered().length > 500);
  @ViewChild('viewport') viewportRef?: ElementRef<HTMLDivElement>;
  readonly scrollTop = signal<number>(0);
  readonly viewportH = signal<number>(320);
  readonly startIndex = computed<number>(() => Math.max(0, Math.floor(this.scrollTop() / this.ROW_H)));
  readonly visibleCount = computed<number>(() => Math.ceil(this.viewportH() / this.ROW_H) + 6);
  readonly endIndex = computed<number>(() => Math.min(this.filtered().length, this.startIndex() + this.visibleCount()));
  readonly translateY = computed<number>(() => this.startIndex() * this.ROW_H);
  readonly totalHeight = computed<number>(() => this.filtered().length * this.ROW_H);
  readonly slice = computed<MessageItem[]>(() => this.filtered().slice(this.startIndex(), this.endIndex()));

  ngOnInit(): void {
    effect(() => {
      // Reset scroll when toggles change significantly or list cleared
      void this.filtered();
      this.onClearScroll();
    }, { injector: this.injector });
  }
  ngAfterViewInit(): void {
    // Measure viewport once DOM is ready
    const el = this.viewportRef?.nativeElement; if (el) this.onViewport(el);
  }

  onViewport(el: HTMLDivElement) {
    // Capture size once; could be enhanced to observe resize
    this.viewportH.set(el.clientHeight || 320);
  }
  onScroll(ev: Event) {
    const el = ev.currentTarget as HTMLDivElement | null;
    if (!el) return;
    this.scrollTop.set(el.scrollTop);
  }
  onClear() { this.engine.clear(); this.onClearScroll(); }
  private onClearScroll() {
    const el = this.viewportRef?.nativeElement; if (!el) return;
    el.scrollTop = 0; this.scrollTop.set(0);
  }
  trackById(_i: number, m: MessageItem) { return m.id; }
}
