/**
 * Ligação do caminho de captura: o PCM do AudioWorklet (ou do ScriptProcessor,
 * em navegador antigo) alimenta o VAD — nível, "a pessoa falou?", quando parar
 * sozinho e microfone mudo. Fica FORA do hook para poder ser testado sem React:
 * o hook injeta o AudioContext e o callback de blocos, e aqui só há
 * feature-detection e conexão de nós.
 *
 * O sink com ganho 0 existe porque um nó precisa estar ligado ao destino para
 * ser processado — e o silêncio impede qualquer eco no alto-falante.
 */

export interface CaptureChain {
  /** Nome do caminho usado (o hook registra isto na sessão/telemetria). */
  tap: "worklet" | "script-processor";
  nodes: AudioNode[];
}

export interface CaptureChainOptions {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  /** Fonte já como string → Blob URL (o hook reaproveita uma única URL). */
  workletUrl: string;
  onBlock: (samples: Float32Array, rms: number, peak: number) => void;
}

/** Conecta a captura de PCM e devolve os nós criados (o hook os desconecta no teardown). */
export async function createCaptureChain({ ctx, source, workletUrl, onBlock }: CaptureChainOptions): Promise<CaptureChain> {
  let tap: AudioNode | null = null;
  let kind: CaptureChain["tap"] = "script-processor";

  if (ctx.audioWorklet) {
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      const worklet = new AudioWorkletNode(ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      worklet.port.onmessage = (event: MessageEvent<{ samples: Float32Array; rms: number; peak: number }>) =>
        onBlock(event.data.samples, event.data.rms, event.data.peak);
      tap = worklet;
      kind = "worklet";
    } catch {
      tap = null; // cai no ScriptProcessor abaixo
    }
  }

  if (!tap) {
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      const copy = new Float32Array(channel);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < copy.length; i += 1) {
        sum += copy[i] * copy[i];
        peak = Math.max(peak, Math.abs(copy[i]));
      }
      onBlock(copy, Math.sqrt(sum / copy.length), peak);
    };
    tap = processor;
  }

  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(tap);
  tap.connect(sink);
  sink.connect(ctx.destination);

  return { tap: kind, nodes: [tap, sink] };
}
