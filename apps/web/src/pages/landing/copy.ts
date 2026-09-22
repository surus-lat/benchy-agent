// All landing copy, per locale. The two locales share one layout; the Spanish
// is rioplatense voseo by design («comillas latinas», "Convertí", "Evaluá"),
// not neutral Spanish. Benchmark example data inside the feature panels is
// illustrative — keep the shapes if you swap in real content.

export type Locale = "en" | "es";

export interface AccessCopy {
  eyebrow: string;
  title: string;
  body: string;
  emailLabel: string;
  orgLabel: string;
  cta: string;
  sending: string;
  invitedPrompt: string;
  login: string;
  success: { title: string; body: string };
  errors: { verification: string; invalid: string; generic: string };
}

export interface LandingCopy {
  htmlLang: string;
  nav: {
    skip: string;
    github: string;
    engine: string;
    login: string;
    openApp: string;
    request: string;
  };
  hero: {
    h1: [string, string];
    subtitle: string;
    pipLabel: string;
    paragraph: string;
    cta: string;
  };
  aws: { badgeAlt: string; lead: [string, string, string]; body: string };
  platform: { src: string; alt: string; caption: string };
  access: AccessCopy;
  rail: {
    ariaLabel: string;
    build: {
      title: string;
      lede: string;
      quote: string;
      blocks: { label: string; lines: string }[];
      note: string;
    };
    generate: {
      title: string;
      lede: string;
      headLeft: string;
      headRight: string;
      rows: { index: string; text: string; status: string; rejected?: boolean }[];
      note: string;
    };
    systems: { title: string; lede: string; chips: string[]; contract: string; note: string };
    run: {
      title: string;
      lede: string;
      metaLeft: string;
      metaRight: string;
      rows: { label: string; value: number; primary: boolean }[];
      caption: string;
    };
    explicit: {
      title: string;
      lede: string;
      lede2: string;
      sources: string[];
      steps: string[];
      note: string;
    };
  };
  closer: { pipLabel: string; title: string; cta: string };
  footer: { by: string; switchLabel: string; switchHref: string; switchTitle: string };
}

const en: LandingCopy = {
  htmlLang: "en",
  nav: {
    skip: "Skip to content",
    github: "Benchy Agent on GitHub",
    engine: "benchy::engine",
    login: "Log in",
    openApp: "Open app",
    request: "Request access",
  },
  hero: {
    h1: ["Turn your research knowledge", "into AI Benchmarks"],
    subtitle: "Shape the future of AI",
    pipLabel: "benchy agent thinking",
    paragraph:
      "Evaluate what AI knows, uncover its blind spots & biases, and build the data that shapes what comes next.",
    cta: "Request access",
  },
  aws: {
    badgeAlt: "Powered by AWS Cloud Computing",
    lead: ["Supported by ", "AWS", " as a social impact project."],
    body: "Compute credits and infrastructure are provided by Amazon Web Services, so access stays free for the universities and research groups we work with.",
  },
  platform: {
    src: "/brand/platform-author-research.png",
    alt: "Benchy Agent authoring view: a peer-reviewed anthropology question with its expected answer and weighted rubric",
    caption:
      "Authoring a doctoral-level benchmark: the question, the expert reference answer, and a weighted rubric the engine can score against.",
  },
  access: {
    eyebrow: "INVITATION ONLY",
    title: "Built for universities and research groups",
    body: "Access is granted per institution while we are in early release. Tell us about your university and what you want to evaluate, and we will send credentials for your group.",
    emailLabel: "Institutional email",
    orgLabel: "University or research group",
    cta: "Request access",
    sending: "Sending…",
    invitedPrompt: "Already invited?",
    login: "Log in",
    success: {
      title: "Request received.",
      body: "We onboard institutions progressively and will email you when your group's access is ready.",
    },
    errors: {
      verification: "We couldn't verify your browser. Please try again.",
      invalid: "Please check the form and try again.",
      generic: "Something went wrong. Please try again in a moment.",
    },
  },
  rail: {
    ariaLabel: "Product highlights",
    build: {
      title: "Build your benchmark",
      lede: "Describe what you want to evaluate. Benchy Agent helps turn it into a precise program, scoring function, data definition, and AI-system configuration.",
      quote: "“Evaluate whether the assistant cites the right statute for a case summary.”",
      blocks: [
        { label: "program", lines: "task: cite_statute\ninput: case_summary\noutput: statute_id + rationale" },
        { label: "scoring", lines: "exact_match: statute_id\nrubric: rationale_quality\nweights: 0.7 / 0.3" },
        { label: "data", lines: "source: course_corpus\nn_items: 240\nconstraints: 1 statute/item" },
        { label: "ai-system", lines: "kind: agent\nadapter: http\nparams: temperature 0.2" },
      ],
      note: "The agent and the authoring UI write the same four blocks — nothing is inferred behind your back.",
    },
    generate: {
      title: "Generate the exam",
      lede: "Generate synthetic benchmark data from your context, constrained and validated by the benchmark you defined.",
      headLeft: "240 items generated from your corpus",
      headRight: "236 valid · 4 rejected",
      rows: [
        { index: "001", text: "Case summary → expected statute 42-B", status: "valid" },
        { index: "002", text: "Case summary → expected statute 17-A", status: "valid" },
        { index: "003", text: "Two statutes in one item — violates constraint", status: "rejected", rejected: true },
        { index: "004", text: "Case summary → expected statute 9-C", status: "valid" },
      ],
      note: "Every item is checked against the data definition before it enters the exam, so generation failures surface as rejections rather than silent noise in your results.",
    },
    systems: {
      title: "AI-systems",
      lede: "Benchmark the thing you actually deploy: a model, AI-node, workflow, agent, or composed AI-system.",
      chips: ["Model", "AI-node", "Workflow", "Agent", "Composed AI-system"],
      contract: "one runtime contract  ──  adapters  ──  your system",
      note: "The engine exposes a single runtime contract and talks to systems through adapters, so external implementations plug in without reshaping the core engine.",
    },
    run: {
      title: "Run & score",
      lede: "Run the exam. Benchy validates every output, scores each evaluation dimension, and produces the benchmark result.",
      metaLeft: "236 items · 3 systems",
      metaRight: "score",
      rows: [
        { label: "statute_id match", value: 0.81, primary: true },
        { label: "rationale rubric", value: 0.64, primary: true },
        { label: "schema validity", value: 0.97, primary: false },
        { label: "refusals", value: 0.06, primary: false },
      ],
      caption:
        "Illustrative run. Every dimension in the definition gets its own score; invalid outputs are recorded, not dropped.",
    },
    explicit: {
      title: "Explicit & reproducible",
      lede: "One benchmark definition, shared by the human, the agent, and the engine.",
      lede2:
        "Benchy Agent and the UI work on the same explicit YAML. The benchmark can be inspected, versioned, reproduced, and executed without hidden benchmark state.",
      sources: ["Human", "Agent", "UI"],
      steps: ["YAML", "compiler", "engine"],
      note: "The YAML/IR architecture exists so benchmark meaning lives in one semantic source, instead of each component interpreting it on its own.",
    },
  },
  closer: {
    pipLabel: "benchy agent",
    title: "Shape the future of Intelligence",
    cta: "Request access",
  },
  footer: {
    by: "by SURUS",
    switchLabel: "ES",
    switchHref: "/es",
    switchTitle: "Versión en español",
  },
};

const es: LandingCopy = {
  htmlLang: "es-AR",
  nav: {
    skip: "Ir al contenido",
    github: "Benchy Agent en GitHub",
    engine: "benchy::engine",
    login: "Ingresar",
    openApp: "Abrir la app",
    request: "Solicitar acceso",
  },
  hero: {
    h1: ["Convertí tu conocimiento", "académico en benchmarks de IA"],
    subtitle: "Dale forma al futuro de la Inteligencia",
    pipLabel: "benchy agent pensando",
    paragraph:
      "Evaluá qué sabe la IA, identificá sus puntos ciegos y sesgos, y construí los datos que definen lo que viene.",
    cta: "Solicitar acceso",
  },
  aws: {
    badgeAlt: "Powered by AWS Cloud Computing",
    lead: ["Con el apoyo de ", "AWS", " como proyecto de impacto social."],
    body: "Los créditos de cómputo y la infraestructura son provistos por Amazon Web Services, por lo que el acceso es gratuito para las universidades y los grupos de investigación con los que trabajamos.",
  },
  platform: {
    src: "/brand/platform-author-research-es.png",
    alt: "Vista de autoría de Benchy Agent: una pregunta de antropología con referato, su respuesta esperada y una rúbrica ponderada",
    caption:
      "Autoría de un benchmark de nivel doctoral: la pregunta, la respuesta experta de referencia y una rúbrica ponderada que el motor puede puntuar.",
  },
  access: {
    eyebrow: "SOLO POR INVITACIÓN",
    title: "Pensado para universidades y grupos de investigación",
    body: "El acceso se otorga por institución mientras estamos en etapa temprana. Contanos sobre tu universidad y qué querés evaluar, y te enviamos las credenciales para tu grupo.",
    emailLabel: "Correo institucional",
    orgLabel: "Universidad o grupo de investigación",
    cta: "Solicitar acceso",
    sending: "Enviando…",
    invitedPrompt: "¿Ya tenés una invitación?",
    login: "Ingresar",
    success: {
      title: "Recibimos tu solicitud.",
      body: "Incorporamos instituciones de manera progresiva y te vamos a escribir cuando el acceso de tu grupo esté listo.",
    },
    errors: {
      verification: "No pudimos verificar tu navegador. Probá de nuevo.",
      invalid: "Revisá los datos e intentá de nuevo.",
      generic: "Algo salió mal. Probá de nuevo en un momento.",
    },
  },
  rail: {
    ariaLabel: "Qué hace la plataforma",
    build: {
      title: "Definí tu benchmark",
      lede: "Describí qué querés evaluar. Benchy Agent te ayuda a convertirlo en un programa preciso, una función de puntaje, una definición de datos y una configuración de sistema de IA.",
      quote: "«Evaluar si el asistente cita la norma correcta a partir del resumen de un caso.»",
      blocks: [
        { label: "programa", lines: "tarea: citar_norma\nentrada: resumen_caso\nsalida: id_norma + fundamento" },
        { label: "puntaje", lines: "coincidencia_exacta: id_norma\nrúbrica: calidad_fundamento\npesos: 0.7 / 0.3" },
        { label: "datos", lines: "fuente: corpus_cátedra\nn_ítems: 240\nrestricciones: 1 norma/ítem" },
        { label: "sistema-de-ia", lines: "tipo: agente\nadaptador: http\nparámetros: temperatura 0.2" },
      ],
      note: "El agente y la interfaz de autoría escriben los mismos cuatro bloques: nada se infiere a tus espaldas.",
    },
    generate: {
      title: "Generá el examen",
      lede: "Generá datos sintéticos de benchmark a partir de tu contexto, restringidos y validados por el benchmark que definiste.",
      headLeft: "240 ítems generados a partir de tu corpus",
      headRight: "236 válidos · 4 rechazados",
      rows: [
        { index: "001", text: "Resumen de caso → norma esperada 42-B", status: "válido" },
        { index: "002", text: "Resumen de caso → norma esperada 17-A", status: "válido" },
        { index: "003", text: "Dos normas en un mismo ítem: viola la restricción", status: "rechazado", rejected: true },
        { index: "004", text: "Resumen de caso → norma esperada 9-C", status: "válido" },
      ],
      note: "Cada ítem se verifica contra la definición de datos antes de entrar al examen: así, las fallas de generación aparecen como rechazos y no como ruido silencioso en tus resultados.",
    },
    systems: {
      title: "Sistemas de IA",
      lede: "Evaluá lo que realmente ponés en producción: un modelo, un nodo de IA, un flujo de trabajo, un agente o un sistema de IA compuesto.",
      chips: ["Modelo", "Nodo de IA", "Flujo de trabajo", "Agente", "Sistema de IA compuesto"],
      contract: "un contrato de ejecución  ──  adaptadores  ──  tu sistema",
      note: "El motor expone un único contrato de ejecución y se comunica con los sistemas mediante adaptadores, de modo que las implementaciones externas se integran sin rediseñar el núcleo.",
    },
    run: {
      title: "Ejecutá y puntuá",
      lede: "Ejecutá el examen. Benchy valida cada salida, puntúa cada dimensión de evaluación y produce el resultado del benchmark.",
      metaLeft: "236 ítems · 3 sistemas",
      metaRight: "puntaje",
      rows: [
        { label: "coincidencia de norma", value: 0.81, primary: true },
        { label: "rúbrica de fundamentación", value: 0.64, primary: true },
        { label: "validez de esquema", value: 0.97, primary: false },
        { label: "rechazos", value: 0.06, primary: false },
      ],
      caption:
        "Ejecución ilustrativa. Cada dimensión de la definición recibe su propio puntaje; las salidas inválidas se registran, no se descartan.",
    },
    explicit: {
      title: "Explícito y reproducible",
      lede: "Una sola definición de benchmark, compartida por la persona, el agente y el motor.",
      lede2:
        "Benchy Agent y la interfaz trabajan sobre el mismo YAML explícito. El benchmark se puede inspeccionar, versionar, reproducir y ejecutar sin estado oculto.",
      sources: ["Persona", "Agente", "Interfaz"],
      steps: ["YAML", "compilador", "motor"],
      note: "La arquitectura YAML/IR existe para que el significado del benchmark viva en una única fuente semántica, en lugar de que cada componente lo interprete por su cuenta.",
    },
  },
  closer: {
    pipLabel: "benchy agent",
    title: "Dale forma al futuro de la Inteligencia",
    cta: "Solicitar acceso",
  },
  footer: {
    by: "by SURUS",
    switchLabel: "EN",
    switchHref: "/",
    switchTitle: "English version",
  },
};

export const COPY: Record<Locale, LandingCopy> = { en, es };
