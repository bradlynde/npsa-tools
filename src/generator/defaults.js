// Initial form state for the generator and the pre-call notes tool.
// Field names here are the contract with saved letters in the database —
// renaming a key orphans that value on every previously saved record.

const defaultPreCallForm = {
  orgName:'', orgType:'church', orgState:'',
  websiteUrl:'',
  meetingDate:'', meetingTime:'', meetingTimezone:'CST',
  zoomUrl:'', zoomId:'', zoomPassword:'',
  attendees:[{ name:'', email:'', phone:'' }],
  extraNotes:'',
};


const defaultForm = {
  clientName:"", clientType:"Church",
  locations:[{name:"",address:"",city:"",state:"",zip:"",programs:["federal"]}],
  programs:[{key:"federal",year:"2026"}],
  contactName:"", contactTitle:"", contactEmail:"", contactPhone:"",
  grantYear:"2026", grantType:"Federal", grantState:"other", engagementModel:"pre-only", pricingTier:"undiscounted",
  proposalServiceModel:"inhouse", proposalFeeModel:"inh",
  customFee:"", customContingencyFee:"",
  installments: false, installmentCount:2,
  installment1Pct:"50", installment1Label:"upon execution",
  installment2Pct:"50", installment2Label:"upon award notification",
  installment3Pct:"", installment3Label:"",
  optNofo:false, optStateSwitch:false, optPostAwardScope:true, optShortNotice:false,
  earlySigningDate:"March 15, 2026", earlySigningAmount:"500",
  postAwardFee:"10,000",
  customClause:"", polishedClause:"",
  // In-house pre-award fields
  inhEngagementModel:"inh-pre-only", inhPricingTier:"undiscounted", inhCustomFee:"", inhCustomContingencyFee:"",
  inhInstallments:false, inhInstallmentCount:2,
  inhInstallment1Pct:"50", inhInstallment1Label:"upon execution",
  inhInstallment2Pct:"50", inhInstallment2Label:"upon award notification",
  inhInstallment3Pct:"", inhInstallment3Label:"",
  inhOptNofo:false, inhOptStateSwitch:false, inhOptPostAwardScope:true, inhOptShortNotice:false,
  inhEarlySigningDate:"March 15, 2026", inhEarlySigningAmount:"1,500",
  inhPostAwardFee:"0",
  inhCustomClause:"", inhPolishedClause:"",
  postFee:"7,000", postPmt1:"40", postPmt2:"30", postPmt3:"30",
  postEffectiveDate:"", postReimbursementOption:"",
  postPrograms:[{key:"federal",year:String(new Date().getFullYear())}],
  postCustomClause:"", postPolishedClause:"",
  // Addendum fields
  addendumClientName:"", addendumOriginalDate:"",
  addendumPrograms:[{key:"illinois",year:String(new Date().getFullYear())}],
  // Grant Writer fields
  gwRecipientName:"", gwRecipientEmail:"", gwOrgName:"",
  gwPrograms:[{key:"federal",year:"2026"}],
  gwDate:"",
  npsa1Name:"", npsa1Email:"", npsa1Phone:"", npsa2Selected:[],
  npsaSignerName:"Brad Lynde", npsaSignerTitle:"Managing Partner", npsaSigningDate:new Date().toISOString().split('T')[0],
  expirationDate:"",
  gwCcContacts:[],
  gwProfFee:"", gwPaymentTerms:"Net 30",
  gwGuar1:true, gwGuar2:false, gwGuar3:true, gwGuar4:false,
  gwGuar4Deadline:"", gwNotes:"",
};


export { defaultForm, defaultPreCallForm };
