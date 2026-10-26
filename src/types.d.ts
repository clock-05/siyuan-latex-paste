/**
 * 思源插件 API 的最小类型声明。
 *
 * 只声明实际用到的成员：插件没有设置面板、不写存储，所以 Setting / saveData
 * 这些一概不留 —— 留着会让人以为某处还在用，也让 `--noUnusedLocals` 之外的
 * 死代码更难发现。
 */
declare module "siyuan" {
  export class Plugin {
    constructor(options: any);
    i18n: Record<string, string>;
    eventBus: {
      on(type: string, listener: (event: CustomEvent<any>) => any): void;
      off(type: string, listener: (event: CustomEvent<any>) => any): void;
    };
    addCommand(command: any): void;
    onload(): void | Promise<void>;
    onunload(): void;
    onLayoutReady(): void;
  }

  export function showMessage(message: string, timeout?: number, type?: string): void;
}

declare module "turndown-plugin-gfm" {
  export const gfm: any;
  export const tables: any;
  export const strikethrough: any;
  export const taskListItems: any;
}

/** 思源插件以 CommonJS 形式导出插件类 */
declare const module: { exports: any };
