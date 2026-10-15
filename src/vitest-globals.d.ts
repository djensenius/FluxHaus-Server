import type { Mock as VitestMock, Mocked as VitestMocked } from 'vite-plus/test';

declare global {
  namespace vi {
    export type Mock<T extends (...args: any[]) => any = (...args: any[]) => any> = VitestMock<T>;
    export type Mocked<T> = VitestMocked<T>;
  }
}

export {};
