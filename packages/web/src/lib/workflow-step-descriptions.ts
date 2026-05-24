export interface WorkflowStepHelp {
  title: string;
  body: string;
}

interface WorkflowStepHelpInput {
  nodeId: string;
  label?: string;
  nodeType?: string;
  agentPersona?: string;
}

const STEP_PATTERNS: [RegExp, WorkflowStepHelp][] = [
  [
    /(read|load).*(spec|wo)|^read-spec$/,
    {
      title: 'Read the work order',
      body: 'Loads the approved spec and turns the human request into the run context the agents will follow.',
    },
  ],
  [
    /preflight|doctor|readiness|check.*ready/,
    {
      title: 'Preflight checks',
      body: 'Confirms the repo, spec, workflow, credentials, and execution surface are ready before code work begins.',
    },
  ],
  [
    /plan|architect|war-council/,
    {
      title: 'Plan the change',
      body: 'Reviews the spec and repo context, then decides the safest implementation path before editing files.',
    },
  ],
  [
    /implement|build|write|code/,
    {
      title: 'Build the change',
      body: 'Applies the requested code, docs, or configuration changes inside the target repo.',
    },
  ],
  [
    /test|verify|validate|grep|type|lint|build-check|smoke/,
    {
      title: 'Verify the work',
      body: 'Runs checks and targeted assertions so the run produces evidence instead of just claiming completion.',
    },
  ],
  [
    /screenshot|preview|browser|visual/,
    {
      title: 'Capture visual proof',
      body: 'Opens or inspects the built surface and records visual evidence for human review.',
    },
  ],
  [
    /commit|push/,
    {
      title: 'Save the branch',
      body: 'Commits the approved diff and pushes the branch so the work is durable and reviewable.',
    },
  ],
  [
    /pr|pull-request|open-pr/,
    {
      title: 'Open review',
      body: 'Creates or updates the pull request with the evidence needed for review and merge decisions.',
    },
  ],
  [
    /manifest|report|summary/,
    {
      title: 'Build the evidence packet',
      body: 'Collects files changed, checks run, PR links, and remaining caveats into a review-ready summary.',
    },
  ],
  [
    /notion|flip|status|archive/,
    {
      title: 'Update tracking',
      body: 'Updates the work tracker or archive state so the queue reflects what actually happened.',
    },
  ],
  [
    /approval|gate|pause/,
    {
      title: 'Wait for approval',
      body: 'Stops at a human decision point before continuing into protected or higher-risk work.',
    },
  ],
];

const TYPE_FALLBACK: Record<string, WorkflowStepHelp> = {
  bash: {
    title: 'Run a shell step',
    body: 'Executes a scripted command such as setup, validation, commit, push, or a repo inspection.',
  },
  command: {
    title: 'Run a Cauldron command',
    body: 'Calls a reusable command from the workflow engine instead of asking an agent to improvise.',
  },
  prompt: {
    title: 'Ask an agent to reason',
    body: 'Gives an agent a focused task, usually planning, implementation, review, or summary generation.',
  },
  loop: {
    title: 'Iterate until complete',
    body: 'Repeats an agent task until the workflow reaches its explicit completion condition or retry limit.',
  },
};

function humanizeNodeId(nodeId: string): string {
  return nodeId
    .replace(/^[-_\s]+|[-_\s]+$/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getWorkflowStepHelp(input: WorkflowStepHelpInput): WorkflowStepHelp {
  const searchText = `${input.nodeId} ${input.label ?? ''}`.toLowerCase();
  for (const [pattern, help] of STEP_PATTERNS) {
    if (pattern.test(searchText)) return help;
  }

  const fallback = input.nodeType ? TYPE_FALLBACK[input.nodeType] : undefined;
  if (fallback) return fallback;

  const title = humanizeNodeId(input.nodeId);
  return {
    title: title ? `Step: ${title}` : 'Workflow step',
    body: input.agentPersona
      ? `Runs with the ${input.agentPersona} persona for this part of the workflow.`
      : 'Runs one stage in the workflow graph and passes its result to downstream steps.',
  };
}
