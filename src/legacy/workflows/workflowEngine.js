const { dispatchAction } = require('../queues/automationProcessor');
const prisma = require('../prisma');

/**
 * Evaluates triggers and dispatches corresponding actions via BullMQ.
 * 
 * @param {string} triggerType e.g., 'MISSED_CALL', 'NEGATIVE_SENTIMENT'
 * @param {object} context Data context for the trigger (customerId, callSid, etc.)
 */
async function evaluateTriggers(triggerType, context) {
  console.log(`[WorkflowEngine] Evaluating triggers for: ${triggerType}`);
  
  try {
    // Find all active workflows that match this trigger
    const workflows = await prisma.workflowAutomation.findMany({
      where: {
        isActive: true,
        triggerType: triggerType
      }
    });

    if (workflows.length === 0) return;

    for (const workflow of workflows) {
      console.log(`[WorkflowEngine] Triggering workflow: ${workflow.name} (${workflow.actionType})`);
      
      // Inject context into the static actionConfig
      let actionConfig = workflow.actionConfig || {};
      
      if (typeof actionConfig === 'string') {
        actionConfig = JSON.parse(actionConfig);
      }

      // Merge context variables (like dynamic customer phone or ticket ids)
      const mergedConfig = { ...actionConfig, ...context };

      // Dispatch to BullMQ for asynchronous background execution
      await dispatchAction({
        workflowId: workflow.id,
        actionType: workflow.actionType,
        actionConfig: mergedConfig,
        targetId: context.targetId || context.callSid || context.customerId
      });
    }

  } catch (error) {
    console.error(`[WorkflowEngine] Evaluation error:`, error);
  }
}

module.exports = {
  evaluateTriggers
};
