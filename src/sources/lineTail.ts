// Lee las líneas nuevas de un archivo desde un offset, tolerando líneas partidas.
//
// Trabaja en bytes: una escritura puede cortar un carácter UTF-8 por la mitad, y la línea solo se
// decodifica cuando llegó completa. No hay nada asíncrono entre leer y avanzar el offset, así que una
// llamada repetida no puede duplicar ni perder líneas.

import { closeSync, openSync, readSync, statSync } from 'node:fs';

const CHUNK_SIZE = 256 * 1024;
const NEWLINE = 0x0a;

export class LineTail {
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);
  private readonly chunk = Buffer.allocUnsafe(CHUNK_SIZE);

  constructor(readonly path: string) {}

  /** Devuelve las líneas completas escritas desde la última llamada. Si el archivo no existe, ninguna. */
  readNewLines(): string[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // El archivo se truncó o reemplazó: se vuelve a empezar.
      this.offset = 0;
      this.carry = Buffer.alloc(0);
    }
    if (size === this.offset) return [];

    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return [];
    }
    const lines: string[] = [];
    try {
      for (;;) {
        const read = readSync(fd, this.chunk, 0, CHUNK_SIZE, this.offset);
        if (read === 0) break;
        this.offset += read;
        this.consume(this.chunk.subarray(0, read), lines);
      }
    } finally {
      closeSync(fd);
    }
    return lines;
  }

  private consume(data: Buffer, lines: string[]): void {
    let start = 0;
    for (;;) {
      const end = data.indexOf(NEWLINE, start);
      if (end < 0) break;
      const piece = data.subarray(start, end);
      const whole = this.carry.length ? Buffer.concat([this.carry, piece]) : piece;
      this.carry = Buffer.alloc(0);
      const line = whole.toString('utf8').replace(/\r$/, '');
      if (line.trim()) lines.push(line);
      start = end + 1;
    }
    if (start < data.length) {
      const rest = Buffer.from(data.subarray(start));
      this.carry = this.carry.length ? Buffer.concat([this.carry, rest]) : rest;
    }
  }
}
