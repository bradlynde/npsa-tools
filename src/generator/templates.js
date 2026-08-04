// Default letter section text for every document type, plus the pre-call
// notes renderer. Editing these changes client-facing wording.

import { marked } from "marked";

// ─── DEFAULT TEMPLATE SECTIONS ────────────────────────────────────────────────
const DEFAULT_PRE = [
  { id:"pre_intro", title:"Introduction", roman:"",
    content:`Lynde Consulting LLC, DBA Nonprofit Security Advisors ("NPSA") proposes to provide [CLIENT_NAME] ("CLIENT") with pre-award consulting, grant writing, and submission services. Award Implementation services, if any, will be governed by a separate written agreement.
The project will encompass various potential security improvements which may include but may not be limited to various services and equipment such as (1) physical security equipment; (2) surveillance and monitoring equipment and services; (3) communications systems; (4) cybersecurity improvements; (5) security training drills; and (6) contracted security personnel.
This engagement specifically applies to the [GRANT_LABEL]. All commitments made below relate to services and projects associated with this program.`},
  { id:"pre_periods", title:"Three Distinct Periods", roman:"I.",
    content:`The [NSGP] process can be described in three distinct periods:
1. Pre-Award Period – This period includes all activities required from the present time through receipt of the award notification.
2. Compliance Period – This period covers all required steps following award notification and prior to CLIENT being authorized to commit funding or begin implementation of approved security improvements.
3. Award Implementation Period – This final period includes project execution, ongoing grant administration, and concludes with successful implementation and reimbursement.
The scope of work under this engagement letter is limited to the Pre-Award and Compliance Periods. While NPSA offers Award Implementation support services, grant rules prohibit CLIENT from engaging NPSA for such services until all Compliance Period requirements have been completed.`},
  { id:"pre_scope", title:"Scope of Work", roman:"II.",
    subsections:[{ id:"pre_scope_pre", title:"A. Pre-Award Period Consulting",
      content:`1. NPSA will complete an initial fact-finding meeting with CLIENT to determine the project goals and to obtain additional preliminary information.
2. NPSA will coordinate with its network of grant specialists and grant writers to determine whether CLIENT is likely eligible for the anticipated [GRANT_YEAR_NSGP].
3. NPSA already believes, but does not guarantee, that CLIENT is likely eligible for one application of the [GRANT_YEAR_NSGP] which includes funding for target hardening and other physical security enhancements. The total maximum grant award is $[MAX_AWARD] per awarded location.
   (a) Under current program guidelines, CLIENT may submit one application per physical address, for up to [NUM_LOCATIONS] distinct location(s). Each location is scored independently and may be awarded the maximum funding amount.
   (b) This engagement includes support for the submission of [NUM_APPLICATIONS] [APPLICATION_PLURAL] for [NUM_LOCATIONS] distinct location(s), at the following address(es):
[LOCATION_LIST]
4. NPSA will identify one or more grant specialists/writers who will provide grant writing and/or consulting related to the grant opportunities, processes, and requirements.
   (a) CLIENT will vet the grant specialist/writers and determine whether to engage in a paid consulting and grant writing contract.
   (b) NPSA receives no referral fees, commissions, or other compensation from any grant specialist/writer.
5. If client elects not to retain the recommended grant writer, Consultant will assist with introductions to an alternative grant writer selected by the client.
6. While NPSA recommends certain grant writers with experience with the NSGP, NPSA does not require CLIENT to choose the grant writer(s) we recommend. However, this engagement is contingent upon CLIENT selecting a professional grant writer with NSGP grant writing experience.
7. If CLIENT chooses to proceed with grant writing services, NPSA will work with CLIENT and grant specialist/grant writer to complete fact finding and obtain preliminary information necessary to proceed.
8. NPSA will assist the grant specialist/writer in arranging for a qualified professional security consultant to be contacted by CLIENT to complete a vulnerability assessment, or will work with the grant specialist/writer to aid CLIENT in completing a self-assessment. In many cases, a professional assessment can be obtained at little or no cost to CLIENT.
9. NPSA will ensure the vulnerability assessment is reviewed with CLIENT and grant specialist/writer and will compare the assessment with CLIENT'S project goals.
10. NPSA will work with CLIENT and the grant specialist/writer to provide program guidance, factual clarification, and administrative coordination consistent with CLIENT'S goals and the vulnerability assessment. Grant application drafting and submission will be performed solely by the grant specialist/writer and/or CLIENT, and not by NPSA.`},
    { id:"pre_scope_post", title:"B. Compliance Period Consulting",
      content:`1. Upon notification that CLIENT has been awarded funding under the [GRANT_YEAR_NSGP], NPSA will provide Award Implementation consulting and administrative support services from the date of award announcement through receipt of formal written clearance from the State authorizing CLIENT to begin committing grant funds.
2. NPSA will attend required State and/or federal Award Implementation webinars and review applicable guidance, timelines, policies, and procedures related to CLIENT'S award.
3. NPSA will assist CLIENT with registration and setup in required State grant management systems and will provide guidance regarding administrative documentation, including internal controls questionnaires (ICQ), risk assessments, and other compliance-related submissions required by the State administering agency.
4. NPSA will guide CLIENT through the State budget review, alignment, and allowability process and will assist in confirming that the approved federal application aligns with State-level requirements and funding conditions.
5. NPSA will provide guidance and administrative coordination related to completion and submission of Environmental and Historic Preservation (EHP) documentation, including assistance with required photographs, annotations, equipment specifications, and follow-up communication until approval is issued.
6. NPSA will review grant award documents and coordinate administrative execution of grant agreements and related documentation.
7. If designated by CLIENT as an authorized point of contact, NPSA will receive and review State communications related to the award and will provide CLIENT with summaries, signature pages, and required action items as appropriate.
8. NPSA will attend required trainings related to procurement, reimbursement, and financial compliance and will provide general guidance to CLIENT regarding applicable procurement standards and reimbursement requirements.
9. NPSA will assist CLIENT with registration or coordination with applicable State comptroller, treasury, or financial systems as required for reimbursement processing.
10. NPSA will provide ongoing coordination and communication support between CLIENT and the State administering agency during the pre-clearance period and will identify required action items and deadlines necessary to obtain clearance to begin committing grant funds.
11. These services apply only to the initial Award Implementation compliance phase required before an award recipient is authorized to begin committing grant funds.
12. These services are advisory and administrative in nature and are intended to assist CLIENT in navigating State-specific Award Implementation requirements. Because Award Implementation procedures vary by State and may change annually, specific tasks, documentation requirements, and administrative processes may differ from those listed above. The services described in this section are intended to reflect the typical scope of assistance provided during the initial Award Implementation compliance phase.
13. NPSA's services under this section shall be deemed complete upon CLIENT's receipt of formal written clearance from the State authorizing the commitment of grant funds. At that time, all services described in this engagement shall be fully performed and earned unless otherwise governed by a separate written agreement.
14. Following receipt of such clearance, CLIENT may elect to engage NPSA under a separate written agreement for project management, solution implementation, procurement coordination, reimbursement coordination, documentation support, and grant close-out services.`}]},
  { id:"pre_liability", title:"Limits of Liability", roman:"III.",
    content:`1. CLIENT acknowledges that NPSA is not providing a vulnerability assessment and is simply providing licensed resources which CLIENT will vet. CLIENT is responsible for the final selection of security personnel and will contract with them independently of NPSA. CLIENT agrees NPSA will not be responsible for any recommendations or lack of recommendations made by security personnel.
2. Regardless of whether CLIENT chooses to complete a self-assessment or chooses to contract with a licensed security consultant, CLIENT will not hold NPSA responsible for any security assessments or decisions.
3. CLIENT acknowledges responsibility for choosing any security contractors or solutions providers. CLIENT is responsible for verifying the solutions are implemented satisfactorily and continue to operate satisfactorily. CLIENT will never hold NPSA responsible for any solutions failures.
4. CLIENT acknowledges that NPSA is not responsible for any security breaches or failures, or any harm caused by any bad actor irrespective of NPSA's role in this engagement.
5. With the exception of liability arising out of intentional and malicious acts by NPSA, CLIENT agrees NPSA shall never be held liable for an amount greater than the total fees paid by CLIENT to NPSA as part of this engagement. Furthermore, to the fullest extent possible, CLIENT shall not pursue NPSA for claims or damages that are covered (assuming compliance with the policy terms), in whole or part, by an insurance policy that insures CLIENT, and CLIENT waives any insurer or insured rights of subrogation related to said claim(s). In those instances, in which a loss could or are covered by insurance, CLIENT shall recover solely from insurance benefits or proceeds.
6. CLIENT agrees that in no event shall NPSA be liable for any indirect, incidental, consequential, special, exemplary, or punitive damages, including but not limited to loss of use, loss of revenue, loss of funding, or loss of goodwill, even if advised of the possibility of such damages.`},
  { id:"pre_conf", title:"Confidentiality", roman:"IV.",
    content:`1. NPSA acknowledges and agrees that all CLIENT information shared by CLIENT as part of this engagement is owned by CLIENT. These documents are valuable assets of the CLIENT. Except for disclosure required to be made to advance the engagement and information which is a matter of public record, NPSA shall not use any information for the benefit of NPSA or any other person except with express written CLIENT consent.
2. CLIENT acknowledges and agrees that all NPSA information shared by NPSA as part of this engagement is owned by NPSA. This information includes but is not limited to this Engagement Letter, sales and marketing materials, cost information, and invoices. CLIENT agrees not to share this information with any person or organization except for the purposes of advancing this engagement.`},
  { id:"pre_resp", title:"Client Responsibilities", roman:"V.",
    content:`1. CLIENT will attend all necessary CLIENT meetings whether in person or via web meeting and will provide reasonable advance notice in the event a meeting needs to be rescheduled.
2. CLIENT will provide all necessary information in a timely manner.
3. CLIENT agrees to make every possible effort to complete client-assigned tasks within a timely manner as set forth by the grant writer/NPSA.
4. CLIENT will be responsible for providing access to CLIENT facilities to grant specialists/grant writers, security consultants, solutions providers, NPSA, and any other project stakeholder. CLIENT acknowledges that NPSA will perform all or most services under this engagement remotely. NPSA will not routinely access CLIENT's facilities. Any task requiring on-site presence, including vulnerability assessments or site reviews, will be completed by CLIENT's employees, contractors, law enforcement partners, or other third-party consultants at CLIENT's expense unless otherwise agreed in writing by both parties.
5. CLIENT acknowledges that while NPSA may assist with reviewing vendor proposals, pricing, and project documentation for purposes of grant compliance and administrative coordination, NPSA does not approve, recommend, warrant, or guarantee the performance, availability, quality, or work of any vendor, contractor, consultant, or solutions provider. CLIENT retains sole and final responsibility for all vendor selection decisions.
6. CLIENT agrees to provide written notice of any issues or problems that may arise within 48 hours of uncovering the issue.`},
  { id:"pre_comp", title:"Compensation", roman:"VI.", content:"[COMP_BLOCK]" },
  { id:"pre_guar", title:"Guarantees of NPSA", roman:"VII.",
    content:`1. NPSA shall perform duties as agreed to by both parties and shall complete these duties in good faith.
2. CLIENT acknowledges that NPSA does not control federal, state, or third-party funding decisions and that no representations or guarantees are made regarding the approval, amount, or timing of any grant award.
3. [NOFO_CLAUSE]
[STATE_NOFO_CLAUSE][GUAR_ROLLOVER]
[GUAR_5_NUM]. If CLIENT elects not to submit an application for the [GRANT_YEAR_NSGP], or if CLIENT fails to provide required information, documentation, approvals, or cooperation necessary to complete the application within required deadlines, no refund shall be issued and all fees paid under this Agreement shall be considered earned.`},
  { id:"pre_cancel", title:"Cancellation", roman:"VIII.",
    content:`1. Cancellation. The CLIENT may terminate this Agreement at any time, at will, and in the CLIENT's sole discretion.
2. Upon termination, NPSA shall cease performing services under this Agreement. No fees will be refunded and any outstanding invoices will remain due.
3. If CLIENT believes NPSA has materially breached this Agreement, CLIENT must provide written notice within forty-eight (48) hours of becoming aware of the alleged breach. NPSA shall be given a reasonable opportunity to cure the alleged breach prior to termination for cause.`},
  { id:"pre_other", title:"Other Terms and Conditions", roman:"IX.",
    content:`1. NPSA is an independent contractor performing services for CLIENT and is not an agent or employee of CLIENT for any purpose.
2. CLIENT acknowledges that NPSA provides consulting and administrative services only and is not acting as a contractor, general contractor, installer, vendor, or solutions provider for any security equipment, systems, or services.
3. CLIENT agrees to provide NPSA with such information, necessary and reasonable, to perform the proposed services.
4. CLIENT is solely responsible for selecting, contracting, and compensating any grant writer.
5. NPSA may provide examples of independent grant writers but does not approve, select, negotiate with, or contract on behalf of CLIENT.
6. This Agreement does not obligate CLIENT to engage NPSA for Award Implementation management and administration services.
7. Following execution of a grant award agreement with the State and receipt of required environmental and historical preservation (EHP) approval, CLIENT may select an Award Implementation management and administration provider. CLIENT is free to select any qualified provider. NPSA may provide such services if CLIENT elects to engage NPSA.
8. In the event CLIENT elects to engage NPSA for Award Implementation management and administration services, such services eligible for reimbursement under the grant will commence only after:
   (a) execution of a separate agreement between CLIENT and NPSA,
   (b) CLIENT's receipt of a fully executed grant award agreement from the State, and
   (c) receipt of required EHP approval.
9. This represents the entire proposal of NPSA. Any change to this document must be in writing and agreed upon by an authorized officer of NPSA. This proposal does not become a contract between CLIENT and NPSA until an officer of NPSA has accepted it and a signed copy returned to CLIENT.
10. The parties agree that any and all legal actions will be brought in the County of Winnebago, State of Illinois. To the extent necessary, the parties agree to submit to jurisdiction and waive any and all venue objections.`},
];
// ─── IN-HOUSE PRE-AWARD TEMPLATE ──────────────────────────────────────────────
const DEFAULT_INH = [
  { id:"inh_intro", title:"Introduction", roman:"",
    content:`Lynde Consulting LLC, DBA Nonprofit Security Advisors ("NPSA") proposes to provide [CLIENT_NAME] ("CLIENT") with pre-award consulting, grant writing, and submission services. Award Implementation services, if any, will be governed by a separate written agreement and will only occur if CLIENT receives notice of a grant award and elects to engage NPSA for such services.
The project will encompass various potential security improvements which may include but may not be limited to various services and equipment such as (1) physical security equipment; (2) surveillance and monitoring equipment and services; (3) communications systems; (4) cybersecurity improvements; (5) security training drills; and (6) contracted security personnel.
This engagement specifically applies to the [GRANT_LABEL]. All commitments made below relate to services and projects associated with this program.`},
  { id:"inh_periods", title:"Three Distinct Periods", roman:"I.",
    content:`The [NSGP] process can be described in three distinct periods:
1. Pre-Award Period – This period includes all activities required from the present time through receipt of the award notification.
2. Compliance Period – This period covers all required steps following award notification and prior to CLIENT being authorized to commit funding or begin implementation of approved security improvements.
3. Award Implementation Period – This final period includes project execution, ongoing grant administration, and concludes with successful implementation and reimbursement.
NPSA will utilize its in-house consulting and grant writing team to deliver the services outlined in this Engagement Letter. While NPSA provides limited Implementation Period Support, the CLIENT will not be eligible for reimbursement through grant funds for any such support under this engagement. The CLIENT may choose to engage a separate firm for Award Implementation if desired.`},
  { id:"inh_scope", title:"Scope of Work", roman:"II.",
    subsections:[{ id:"inh_scope_pre", title:"A. Pre-Award Period Consulting",
      content:`1. NPSA will complete an initial fact-finding meeting with CLIENT to determine the project goals and to obtain additional preliminary information.
2. NPSA will evaluate CLIENT's eligibility for the anticipated [GRANT_YEAR_NSGP].
3. NPSA already believes, but does not guarantee, that CLIENT is likely eligible for one application of the [GRANT_YEAR_NSGP] which includes funding for target hardening and other physical security enhancements. The total maximum grant award is $[MAX_AWARD] per awarded location.
   (a) Under current program guidelines, CLIENT may submit one application per physical address, for up to [NUM_LOCATIONS] distinct location(s). Each location is scored independently and may be awarded the maximum funding amount.
   (b) This engagement includes support for the submission of [NUM_APPLICATIONS] [APPLICATION_PLURAL] for [NUM_LOCATIONS] distinct location(s), at the following address(es):
[LOCATION_LIST]
4. NPSA will provide grant writing and application development services directly on behalf of CLIENT, including all drafting, compilation, and submission of the grant application.
5. NPSA will arrange for a qualified professional security consultant to be contacted by CLIENT to complete a vulnerability assessment, or will work with CLIENT to complete a self-assessment. In many cases, a professional assessment can be obtained at little or no cost to CLIENT.
6. NPSA will review the vulnerability assessment with CLIENT and compare it with CLIENT's project goals.
7. NPSA will provide program guidance, factual clarification, and administrative coordination consistent with CLIENT's goals and the vulnerability assessment.
8. NPSA will coordinate all grant application drafting and submission activities and will work directly with CLIENT to finalize and submit the completed application.`},
    { id:"inh_scope_post", title:"B. Compliance Period Consulting",
      content:`1. Upon notification that CLIENT has been awarded funding under the [GRANT_YEAR_NSGP], NPSA will provide Award Implementation consulting and administrative support services from the date of award announcement through receipt of formal written clearance from the State authorizing CLIENT to begin committing grant funds.
2. NPSA will attend required State and/or federal Award Implementation webinars and review applicable guidance, timelines, policies, and procedures related to CLIENT'S award.
3. NPSA will assist CLIENT with registration and setup in required State grant management systems and will provide guidance regarding administrative documentation, including internal controls questionnaires (ICQ), risk assessments, and other compliance-related submissions required by the State administering agency.
4. NPSA will guide CLIENT through the State budget review, alignment, and allowability process and will assist in confirming that the approved federal application aligns with State-level requirements and funding conditions.
5. NPSA will provide guidance and administrative coordination related to completion and submission of Environmental and Historic Preservation (EHP) documentation, including assistance with required photographs, annotations, equipment specifications, and follow-up communication until approval is issued.
6. NPSA will review grant award documents and coordinate administrative execution of grant agreements and related documentation.
7. If designated by CLIENT as an authorized point of contact, NPSA will receive and review State communications related to the award and will provide CLIENT with summaries, signature pages, and required action items as appropriate.
8. NPSA will attend required trainings related to procurement, reimbursement, and financial compliance and will provide general guidance to CLIENT regarding applicable procurement standards and reimbursement requirements.
9. NPSA will assist CLIENT with registration or coordination with applicable State comptroller, treasury, or financial systems as required for reimbursement processing.
10. NPSA will provide ongoing coordination and communication support between CLIENT and the State administering agency during the pre-clearance period and will identify required action items and deadlines necessary to obtain clearance to begin committing grant funds.
11. These services apply only to the initial Award Implementation compliance phase required before an award recipient is authorized to begin committing grant funds.
12. These services are advisory and administrative in nature and are intended to assist CLIENT in navigating State-specific Award Implementation requirements. Because Award Implementation procedures vary by State and may change annually, specific tasks, documentation requirements, and administrative processes may differ from those listed above.
13. NPSA's services under this section shall be deemed complete upon CLIENT's receipt of formal written clearance from the State authorizing the commitment of grant funds. At that time, all services described in this engagement shall be fully performed and earned unless otherwise governed by a separate written agreement.
14. Following receipt of such clearance, CLIENT may elect to engage NPSA under a separate written agreement for project management, solution implementation, procurement coordination, reimbursement coordination, documentation support, and grant close-out services.`}]},
  { id:"inh_liability", title:"Limits of Liability", roman:"III.",
    content:`1. CLIENT acknowledges that NPSA is not providing a vulnerability assessment and is simply providing licensed resources which CLIENT will vet. CLIENT is responsible for the final selection of security personnel and will contract with them independently of NPSA. CLIENT agrees NPSA will not be responsible for any recommendations or lack of recommendations made by security personnel.
2. Regardless of whether CLIENT chooses to complete a self-assessment or chooses to contract with a licensed security consultant, CLIENT will not hold NPSA responsible for any security assessments or decisions.
3. CLIENT acknowledges responsibility for selecting any security consultants, contractors, or solutions providers, including those providing vulnerability assessments, quotes, estimates, or implementation services related to the proposed project. CLIENT is solely responsible for evaluating and selecting such providers and for verifying that any products or services obtained from those providers are satisfactory and continue to operate satisfactorily. CLIENT agrees that NPSA shall not be responsible for the recommendations, performance, or failures of any third-party consultant, contractor, or solutions provider.
4. CLIENT acknowledges that NPSA is not responsible for any security breaches or failures, or any harm caused by any bad actor irrespective of NPSA's role in this engagement.
5. Except for liability arising from the intentional and malicious acts of NPSA, CLIENT agrees that NPSA shall not be liable for any amount greater than the total fees paid by CLIENT to NPSA in connection with this engagement. Furthermore, to the fullest extent permitted by law, CLIENT shall not pursue NPSA for claims or damages that are covered, in whole or in part (assuming compliance with the applicable policy terms), by an insurance policy maintained by CLIENT. CLIENT hereby waives any insurer or insured rights of subrogation related to such claims. In instances where a loss is or could be covered by insurance, CLIENT agrees that recovery shall be limited solely to available insurance benefits or proceeds.
6. CLIENT agrees that in no event shall NPSA be liable for any indirect, incidental, consequential, special, exemplary, or punitive damages, including but not limited to loss of use, loss of revenue, loss of funding, or loss of goodwill, even if advised of the possibility of such damages.`},
  { id:"inh_conf", title:"Confidentiality", roman:"IV.",
    content:`1. NPSA acknowledges and agrees that all CLIENT information shared by CLIENT as part of this engagement is owned by CLIENT. These documents are valuable assets of the CLIENT. Except for disclosure required to be made to advance the engagement and information which is a matter of public record, NPSA shall not use any information for the benefit of NPSA or any other person except with express written CLIENT consent.
2. CLIENT acknowledges and agrees that all NPSA information shared by NPSA as part of this engagement is owned by NPSA. This information includes but is not limited to this Engagement Letter, sales and marketing materials, cost information, workbooks, information collection tools, and invoices. CLIENT agrees not to share this information with any person or organization except for the purposes of advancing this engagement.`},
  { id:"inh_resp", title:"Client Responsibilities", roman:"V.",
    content:`1. CLIENT will attend all necessary CLIENT meetings whether in person or via web meeting and will provide reasonable advance notice in the event a meeting needs to be rescheduled.
2. CLIENT will provide all necessary information in a timely manner.
3. CLIENT agrees to make every possible effort to complete client-assigned tasks within a timely manner as set forth by NPSA.
4. CLIENT will be responsible for providing access to CLIENT facilities to security consultants, solutions providers, NPSA, and any other project stakeholder. CLIENT acknowledges that NPSA will perform all or most services under this engagement remotely. NPSA will not routinely access CLIENT's facilities. Any task requiring on-site presence, including vulnerability assessments or site reviews, will be completed by CLIENT's employees, contractors, law enforcement partners, or other third-party consultants at CLIENT's expense unless otherwise agreed in writing by both parties.
5. CLIENT acknowledges that while NPSA may assist with reviewing vendor proposals, pricing, and project documentation for purposes of grant compliance and administrative coordination, NPSA does not approve, recommend, warrant, or guarantee the performance, availability, quality, or work of any vendor, contractor, consultant, or solutions provider. CLIENT retains sole and final responsibility for all vendor selection decisions.
6. CLIENT agrees to provide written notice of any issues or problems that may arise within 48 hours of uncovering the issue.`},
  { id:"inh_comp", title:"Compensation", roman:"VI.", content:"[COMP_BLOCK]" },
  { id:"inh_guar", title:"Guarantees of NPSA", roman:"VII.",
    content:`1. NPSA shall perform duties as agreed to by both parties and shall complete these duties in good faith.
2. CLIENT acknowledges that NPSA does not control federal, state, or third-party funding decisions and that no representations or guarantees are made regarding the approval, amount, or timing of any grant award.
3. [NOFO_CLAUSE]
[STATE_NOFO_CLAUSE][GUAR_ROLLOVER]
[GUAR_5_NUM]. If CLIENT elects not to submit a completed application ready for submission for the [GRANT_YEAR_NSGP], or if CLIENT fails to provide required information, documentation, approvals, or cooperation necessary to complete the application within required deadlines, no refund shall be issued and all fees paid under this Agreement shall be considered earned.`},
  { id:"inh_cancel", title:"Cancellation", roman:"VIII.",
    content:`1. Cancellation. The CLIENT may terminate this Agreement at any time, at will, and in the CLIENT's sole discretion.
2. Upon termination, NPSA shall cease performing services under this Agreement. No fees will be refunded and any outstanding invoices will remain due.
3. If CLIENT believes NPSA has materially breached this Agreement, CLIENT must provide written notice within forty-eight (48) hours of becoming aware of the alleged breach. NPSA shall be given a reasonable opportunity to cure the alleged breach prior to termination for cause.`},
  { id:"inh_other", title:"Other Terms and Conditions", roman:"IX.",
    content:`1. NPSA is an independent contractor performing services for CLIENT and is not an agent or employee of CLIENT for any purpose.
2. CLIENT acknowledges that NPSA provides consulting and administrative services only and is not acting as a contractor, general contractor, installer, vendor, or solutions provider for any security equipment, systems, or services.
3. CLIENT agrees to provide NPSA with such information, necessary and reasonable, to perform the proposed services.
4. The services provided under this Agreement are limited to pre-award consulting, grant writing, and submission of the grant application for the applicable Nonprofit Security Grant Program funding cycle. NPSA's services under this Agreement conclude upon submission of the completed application for that funding cycle, except as otherwise provided in Section VI (Guarantees of NPSA) relating to a subsequent NSGP opportunity.
5. This Agreement does not obligate CLIENT to engage NPSA for any Award Implementation consulting, grant management, or grant administration services. If CLIENT receives notice of a grant award and elects to engage NPSA for Award Implementation services, such services will be governed by a separate written agreement executed after CLIENT has received formal notice of award. CLIENT acknowledges that because NPSA provided grant writing services under this Agreement, any Award Implementation consulting, management, or administration services provided by NPSA for the same grant award must be paid directly by CLIENT and may not be charged to, reimbursed from, or otherwise paid using grant funds unless expressly permitted in writing by the applicable administering authority.
6. This represents the entire proposal of NPSA. Any change to this document must be in writing and agreed upon by an authorized officer of NPSA. This proposal does not become a contract between CLIENT and NPSA until an officer of NPSA has accepted it and a signed copy returned to CLIENT.
7. The parties agree that any and all legal actions will be brought in the County of Winnebago, State of Illinois. To the extent necessary, the parties agree to submit to jurisdiction and waive any and all venue objections.`},
];
const DEFAULT_POST = [
  { id:"post_intro", title:"Introduction", roman:"",
    content:`Lynde Consulting LLC, d/b/a Nonprofit Security Advisors ("NPSA"), proposes to provide [CLIENT_NAME] ("CLIENT") with consulting, management, and administrative services associated with the implementation of an already-awarded [GRANT_YEAR] Nonprofit Security Grant Program ("NSGP")[STATE_FULL_SUFFIX] project.
This engagement applies exclusively to Award Implementation grant management, procurement support, compliance, documentation, and close-out services related to CLIENT's NSGP[STATE_AWARD_SUFFIX] award. NPSA will not provide grant writing, application development, or pre-award consulting under this agreement.`},
  { id:"post_scope", title:"Scope of Work", roman:"I.",
    content:`1. NPSA will provide Award Implementation Management & Administration (M&A) support services, including but not limited to the following:
   (a) Grant & Compliance Review
       i.  Review of NSGP award documents, approved Investment Justification, allowable costs, and applicable federal and state compliance requirements.
       ii. Establishment of a compliance and reimbursement calendar aligned with grant deadlines.
   (b) Procurement Support
       i.  Leadership and guidance regarding FEMA, state, and federal procurement requirements.
       ii. Coordination of competitive procurement, including obtaining multiple qualified vendor proposals as required.
       iii. Preparation of proposal comparison summaries and written recommendations.
       iv. Review of vendor contracts for required grant-related terms and conditions.
   (c) Project Management & Oversight
       i.  Ongoing coordination with CLIENT and selected vendors.
       ii. Regular virtual status meetings and milestone tracking.
       iii. Support throughout implementation to ensure alignment with approved scope and budget.
   (d) Reimbursement & Documentation
       i.  Review of reimbursement packets prior to submission by CLIENT.
       ii. Ongoing documentation support to ensure audit-ready records.
       iii. Final close-out review and preparation of an organized, comprehensive project file for grant close-out and potential audit.
2. NPSA provides independent consulting and administrative services only and is not acting as a contractor, general contractor, or vendor for any physical security solutions.`},
  { id:"post_liability", title:"Limits of Liability", roman:"II.",
    content:`1. CLIENT acknowledges that NPSA does not provide security assessments, engineering services, or physical security installations. CLIENT is solely responsible for selecting, contracting with, supervising, and overseeing all vendors, contractors, security personnel, and solution providers. CLIENT further acknowledges that NPSA is not responsible for the design, evaluation, or determination of CLIENT's security plan and that NPSA's role is limited to providing implementation support and project management services for security solutions that CLIENT has independently determined to be appropriate and for which funding has been awarded.
2. CLIENT acknowledges responsibility for verifying that all security solutions are properly installed, implemented, maintained, and continue to operate in a satisfactory and effective manner.
3. CLIENT agrees that NPSA shall not be responsible for:
   (a) The acts, omissions, performance, or failures of any third-party vendors, contractors, security personnel, or solution providers;
   (b) The effectiveness of any implemented security solutions, including any determination or verification that such solutions have been properly installed, implemented, maintained, or continue to operate satisfactorily or effectively;
   (c) Any security incidents, breaches, losses, damages, or harm caused by third parties or bad actors.
4. Except in cases of intentional and malicious acts by NPSA, NPSA's total liability under this engagement shall not exceed the total fees paid by CLIENT to NPSA.
5. To the fullest extent permitted by law, CLIENT agrees as follows:
   (a) CLIENT shall not pursue NPSA for any claims or damages that are covered, in whole or in part, by an insurance policy maintained by CLIENT, assuming compliance with the applicable policy terms;
   (b) CLIENT expressly waives any insurer or insured rights of subrogation related to such claims;
   (c) In any instance where a loss is covered, or could be covered, by insurance, CLIENT agrees that recovery shall be sought solely from applicable insurance benefits or proceeds.
6. CLIENT agrees that in no event shall NPSA be liable for any indirect, incidental, consequential, special, exemplary, or punitive damages, including but not limited to loss of use, loss of revenue, loss of funding, or loss of goodwill, even if advised of the possibility of such damages.`},
  { id:"post_conf", title:"Confidentiality", roman:"III.",
    content:`1. NPSA acknowledges and agrees that all CLIENT information shared by CLIENT as part of this engagement is owned by CLIENT. These documents are valuable assets of the CLIENT. Except for disclosure required to be made to advance the engagement and information which is a matter of public record, NPSA shall not use any information for the benefit of NPSA or any other person except with express written CLIENT consent.
2. All NPSA materials, including this Engagement Letter, methodologies, tools, pricing, and documentation templates, remain the property of NPSA and may not be shared except as necessary to advance the engagement.`},
  { id:"post_resp", title:"Client Responsibilities", roman:"IV.",
    content:`1. CLIENT agrees to:
   (a) Participate in all required meetings, whether in person or via web-based meeting, and provide reasonable advance notice if a meeting must be rescheduled;
   (b) Provide all information, documentation, approvals, and responses reasonably requested by NPSA in a timely and accurate manner;
   (c) Make every possible effort to complete the project within twelve (12) months of the execution of this Engagement Letter and acknowledges that delays attributable to CLIENT, including delays in decision-making, procurement, access, or coordination, may extend the project timeline without relieving CLIENT of its obligations under this agreement;
   (d) Provide access to CLIENT facilities as required for vendor coordination, site visits, implementation activities, inspections, and project oversight;
   (e) Ensure that appropriate and informed CLIENT personnel are available to provide access, answer questions, facilitate coordination, and assist in overseeing the completion of solution implementation activities;
   (f) Contract directly with and be solely responsible for payment to all vendors, contractors, consultants, and service providers;
   (g) Provide written notice to NPSA of any issues, delays, concerns, or problems related to the project within forty-eight (48) hours of discovery.
2. CLIENT acknowledges and agrees that NPSA will perform all or most services under this engagement remotely and that on-site access for vendors, consultants, and other project stakeholders is the sole responsibility of CLIENT.
3. CLIENT acknowledges and agrees that while NPSA may assist with vendor identification, coordination, and procurement support, NPSA does not guarantee the availability, performance, quality, or work of any third parties, including vendors, contractors, consultants, or service providers, and that CLIENT retains sole and final responsibility for all vendor selection decisions.`},
  { id:"post_comp", title:"Compensation", roman:"V.",
    content:`1. Total Fixed Fee: [POST_FEE]
2. Payment Schedule:
   (a) [POST_PMT1]% due at signing of this Engagement Letter
   (b) [POST_PMT2]% due after completion of procurement activities
   (c) [POST_PMT3]% due after submission of final reimbursement documentation
3. Invoices are payable within 30 days. CLIENT is responsible for all payments to third-party vendors and service providers. NPSA does not advance or disburse funds on CLIENT's behalf.`},
  { id:"post_term", title:"Term & Termination", roman:"VI.",
    content:`1. Term. This Agreement shall commence upon execution by both parties and shall remain in effect until completion of the services described herein, unless earlier terminated as provided below.
2. Termination by CLIENT (Without Cause). CLIENT may terminate this Agreement at any time upon written notice to NPSA. In the event of termination, CLIENT shall be responsible for payment of all fees earned as of the effective date of termination. For purposes of this Agreement, "earned" shall mean:
   (a) The full amount of any completed milestone payment as described in the Compensation section; and
   (b) A prorated portion of the next unpaid milestone, calculated in good faith by NPSA based on the percentage of work completed toward that milestone at the time of termination, including but not limited to procurement coordination, vendor communications, documentation preparation, reimbursement preparation, monitoring activities, or close-out documentation; and
   (c) Any reasonable, documented out-of-pocket expenses incurred by NPSA in performance of services under this Agreement.
   Upon termination, NPSA shall cease performance of services except as reasonably necessary to provide an orderly transition of documentation already prepared.
3. Termination by NPSA (For Cause). NPSA may terminate upon written notice if CLIENT:
   (a) Fails to make required payments when due;
   (b) Fails to provide necessary documentation, access, or cooperation; or
   (c) Materially breaches any provision of this Agreement.
   All earned fees shall become immediately due and payable.`},
  { id:"post_other", title:"Other Terms", roman:"VII.",
    content:`1. NPSA is an independent contractor and not an employee or agent of CLIENT.
2. This Engagement Letter constitutes the entire agreement between the parties and supersedes all prior discussions.
3. This proposal does not become a contract between CLIENT and NPSA until an officer of NPSA has accepted it and signed a copy returned to CLIENT.
4. Any amendments must be in writing and signed by both parties.
5. The parties agree that any and all legal actions will be brought in the County of Winnebago, State of Illinois. To the extent necessary, the parties agree to submit to jurisdiction and waive any and all venue objections.`},
];
// ─── ADDENDUM TEMPLATE ────────────────────────────────────────────────────────
const DEFAULT_ADDENDUM = {
  sections: [
    { id:"add_purpose", heading:"1. Purpose of Addendum",
      content:`The purpose of this Addendum is to address certain services included in the original Agreement that relate to post-award grant implementation activities (the "Implementation Period"), including management, administrative, and project oversight services following a grant award.
Applicable grant program rules for [ADDENDUM_PROGRAM_RULES] require that services associated with the Implementation Period not be contracted for prior to completion of required award compliance steps.
At the time the Agreement was executed, both parties included these services in anticipation of a potential award. Upon further review of applicable grant guidance, NPSA has determined that inclusion of Implementation Period services in the original Agreement was premature.` },
    { id:"add_remove", heading:"2. Mutual Agreement to Remove Implementation Period Services",
      content:`Accordingly, NPSA and CLIENT mutually agree to remove and cancel all services, obligations, and compensation provisions related to the Implementation Period under the Agreement, including but not limited to:
- Project management and oversight of vendor implementation
- Procurement support and bid coordination post-award
- Any administrative or management services performed after grant award
- Any fees associated with such services, including but not limited to the percentage-based fee outlined in Compensation Section 2
This removal applies to [ADDENDUM_PROGRAMS].` },
    { id:"add_noobligation", heading:"3. No Obligation to Enter New Agreement",
      content:`NPSA may present CLIENT with a separate agreement covering Implementation Period (Management and Administration) services following completion of all required award compliance steps.
CLIENT is under no obligation to enter into any new agreement, and this Addendum does not create any requirement for CLIENT to do so.` },
    { id:"add_preservation", heading:"4. Preservation of Remaining Terms",
      content:`All other terms, conditions, and provisions of the original Agreement—including those related to pre-award consulting, grant support, and initial services—remain in full force and effect.` },
    { id:"add_intent", heading:"5. Intent and Good Faith",
      content:`This Addendum is executed in good faith by both parties to ensure compliance with applicable grant requirements and to preserve CLIENT's ability to seek reimbursement or include eligible costs associated with Implementation Period services under applicable grant programs.` },
  ],
};
// ─── PROPOSAL TEMPLATE ────────────────────────────────────────────────────────
const DEFAULT_PROPOSAL = {
  execSummary: `Nonprofit Security Advisors (NPSA) proposes to provide grant consulting, grant writing, and administrative support to assist [CLIENT_NAME] in pursuing funding through the [PROPOSAL_PROGRAM_LIST]. This proposal is intended to provide leadership with a concise overview of services, deliverables, and investment.`,
  execSummaryFull: `Nonprofit Security Advisors (NPSA) proposes to provide end-to-end grant consulting, grant writing, administrative support, and award implementation services to assist [CLIENT_NAME] in pursuing and executing funding through the [PROPOSAL_PROGRAM_LIST]. This proposal is intended to provide leadership with a concise overview of services, deliverables, and investment across all phases of the grant lifecycle.`,
  execSummaryThirdParty: `Nonprofit Security Advisors (NPSA) proposes to provide grant consulting, advisory, and administrative support to assist [CLIENT_NAME] in pursuing funding through the [PROPOSAL_PROGRAM_LIST]. CLIENT will engage an independent grant writer to prepare and submit the application(s), while NPSA provides program guidance, coordination, and compliance support. This proposal is intended to provide leadership with a concise overview of services, deliverables, and investment.`,
  execSummaryFullThirdParty: `Nonprofit Security Advisors (NPSA) proposes to provide end-to-end grant consulting, advisory, administrative support, and award implementation services to assist [CLIENT_NAME] in pursuing and executing funding through the [PROPOSAL_PROGRAM_LIST]. CLIENT will engage an independent grant writer to prepare and submit the application(s), while NPSA provides program guidance, coordination, compliance, and implementation support. This proposal is intended to provide leadership with a concise overview of services, deliverables, and investment across all phases of the grant lifecycle.`,
  phaseThirdParty: { title:"1. PRE-AWARD PERIOD — GRANT DEVELOPMENT COORDINATION & ADVISORY",
      body:"NPSA coordinates the pre-award process and provides advisory support from project planning through submission, including eligibility review, vulnerability assessment coordination, project prioritization, and budget guidance. An independent grant writer, engaged directly by CLIENT, performs the grant writing, application preparation, and submission. NPSA facilitates introductions to qualified grant writers and coordinates throughout to keep the application on track.",
      deliverable:"Completed [PROPOSAL_PROGRAM_ACRONYMS] application packages submitted for funding consideration." },
  phases: [
    { title:"1. PRE-AWARD PERIOD — WHITE-GLOVE GRANT DEVELOPMENT SUPPORT",
      body:"NPSA manages the application process from project planning through submission, including eligibility review, vulnerability assessment coordination, project prioritization, budget development, grant writing, application preparation, and submission management.",
      deliverable:"Completed [PROPOSAL_PROGRAM_ACRONYMS] application packages submitted for funding consideration." },
    { title:"2. COMPLIANCE PERIOD — WHITE-GLOVE POST-AWARD SUPPORT",
      body:"If funding is awarded, NPSA guides [CLIENT_NAME] through the administrative and compliance steps required to reach State authorization to proceed. Services include registration assistance, compliance documentation, EHP coordination, budget alignment, grant agreement review, procurement guidance, and coordination with the State administering agency.",
      deliverable:"Formal State authorization permitting the organization to begin committing grant funds." },
    { title:"3. AWARD IMPLEMENTATION PERIOD — OPTIONAL, UNDER SEPARATE AGREEMENT",
      body:"Award implementation support is not included in this engagement. Grant program rules prohibit contracting for implementation services until all compliance requirements have been completed. Following State authorization, NPSA is available — at CLIENT's election — to provide implementation planning, procurement coordination, reimbursement readiness, documentation, and grant administration support under a separate written agreement.",
      deliverable:null },
  ],
  phaseImplementationFull: { title:"3. AWARD IMPLEMENTATION PERIOD — WHITE-GLOVE PROJECT MANAGEMENT & ADMINISTRATION",
    body:"Following State authorization to proceed, NPSA manages the project through to completion. Services include implementation planning, procurement coordination and bid support, vendor and installation oversight, reimbursement preparation and submission, ongoing grant administration, and project close-out. Because grant program rules prohibit contracting for implementation services until all compliance requirements have been completed, these services are formally engaged following State authorization and are billed as a percentage-based fee upon award, as set forth in the governing Engagement Letter.",
    deliverable:"Fully implemented security improvements, complete grant administration, and successful project close-out and reimbursement." },
  eligible: "Physical security enhancements • Surveillance systems • Access control systems • Communications systems • Cybersecurity improvements • Security training and exercises • Contracted security personnel",
  note: "This proposal is a summary for leadership review. The complete scope of services, client responsibilities, limitations, compensation provisions, and governing terms are contained in the associated Engagement Letter, which controls in the event of any inconsistency.",
};
// Shared NPSA branding stylesheet injected into both the on-screen preview
// and the Print/PDF window (same string used in both places).
const PC_NOTES_CSS = `
  .pc h1{font-size:22px;font-weight:800;color:#182230;margin:0 0 3px;letter-spacing:-0.2px;line-height:1.2}
  .pc h2{font-size:12.5px;font-weight:700;color:#1e3a5f;text-transform:uppercase;letter-spacing:0.7px;margin:22px 0 9px;padding-bottom:6px;border-bottom:2px solid #dce8f4}
  .pc h3{font-size:13px;font-weight:700;color:#182230;margin:14px 0 5px}
  .pc p{margin:0 0 10px;line-height:1.62;color:#26334d;font-size:14px}
  .pc ul{margin:0 0 12px;padding-left:20px}
  .pc li{margin:0 0 4px;line-height:1.55;color:#26334d;font-size:14px}
  .pc ol{margin:0 0 12px;padding-left:20px}
  .pc ol li{margin:0 0 4px;line-height:1.55;color:#26334d;font-size:14px}
  .pc strong{color:#182230;font-weight:700}
  .pc a{color:#1e3a5f;text-decoration:none}
  .pc hr{border:none;border-top:1px solid #e2ecf5;margin:18px 0}
  .pc blockquote{border-left:3px solid #dce8f4;margin:0 0 12px;padding:8px 14px;background:#f7fafd;color:#4a5462;font-size:13px}
`;
function renderPreCallHtml(md){ return `<style>${PC_NOTES_CSS}</style><div class="pc">${marked(String(md||''))}</div>`; }

export {
  DEFAULT_PRE, DEFAULT_INH, DEFAULT_POST, DEFAULT_ADDENDUM, DEFAULT_PROPOSAL,
  PC_NOTES_CSS, renderPreCallHtml,
};
