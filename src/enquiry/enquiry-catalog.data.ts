export interface FoundationCatalogDefinition {
  key: string;
  name: string;
  category: string;
  services: Array<{
    name: string;
    code: string;
    isEmergency?: boolean;
    subServices?: string[];
    description?: string;
  }>;
}

export const INITIAL_FOUNDATIONS: FoundationCatalogDefinition[] = [
  {
    key: 'UEC',
    name: 'Universal Elder Care',
    category: 'Elder Care & Residential Intake',
    services: [
      {
        name: 'Assisted Living',
        code: 'UEC_ASSISTED_LIVING',
        description: 'Assisted living services for seniors needing personal care support.',
        subServices: ['Daily Living Assistance', 'Medication Management', 'Meal Support', 'Personal Hygiene'],
      },
      {
        name: 'Dementia / Alzheimer\'s Care',
        code: 'UEC_DEMENTIA_CARE',
        description: 'Specialized memory care and cognitive stimulation therapy.',
        subServices: ['Memory Care Unit', 'Wandering Prevention', 'Cognitive Activities', '24/7 Attendant Support'],
      },
      {
        name: 'Post-operative Care',
        code: 'UEC_POST_OPERATIVE',
        description: 'Short and long term post-surgical recovery care and rehabilitation.',
        subServices: ['Wound Dressing', 'Post-Op Monitoring', 'Pain Management', 'Rehabilitation Mobility'],
      },
      {
        name: 'Palliative Care',
        code: 'UEC_PALLIATIVE_CARE',
        description: 'Compassionate comfort and symptom management care for chronic/terminal conditions.',
        subServices: ['Pain & Symptom Relief', 'Emotional & Family Support', 'Doctor Consultations', 'Comfort Nursing'],
      },
      {
        name: 'Bedridden Patient Care',
        code: 'UEC_BEDRIDDEN_CARE',
        description: 'Comprehensive 24/7 bedside nursing and hygiene care for non-ambulatory patients.',
        subServices: ['Position Changing / Q2H Turning', 'Catheter & Ryle\'s Tube Care', 'Bed Bath & Grooming', 'Vitals Monitoring'],
      },
      {
        name: 'Bed Sore / Pressure Injury Care',
        code: 'UEC_PRESSURE_INJURY_CARE',
        description: 'Specialized stage 1-4 pressure ulcer management and prevention.',
        subServices: ['Air Mattress Setup', 'Debridement & Advanced Dressing', 'Nutritional Support', 'Skin Integrity Assessment'],
      },
      {
        name: 'Home Care',
        code: 'UEC_HOME_CARE',
        description: 'In-home caregiving and nursing support for elders in their own residence.',
        subServices: ['12-Hour Day Attendant', '12-Hour Night Attendant', '24-Hour Live-in Caregiver', 'Visiting Nurse'],
      },
      {
        name: 'Other Care Requirements',
        code: 'UEC_OTHER_CARE',
        description: 'Custom care plans tailored to individual elder and family requirements.',
        subServices: ['Custom Care Plan', 'Short Respite Stay', 'Specialized Diet & Physical Therapy'],
      },
    ],
  },
  {
    key: 'A_CARE',
    name: 'A Care / Anbu Sri Sai Home Nursing',
    category: 'Home & Support Services',
    services: [
      { name: 'Doctor at Home', code: 'ACARE_DOCTOR_HOME', subServices: ['General Physician Visit', 'Geriatric Specialist Visit', 'Tele-consult Follow-up'] },
      { name: 'Nursing Care at Home', code: 'ACARE_NURSING_HOME', subServices: ['IV / IM Injections', 'Catheterization', 'Dressing / Wound Care', 'Tracheostomy Care'] },
      { name: 'Elder Care at Home', code: 'ACARE_ELDER_CARE_HOME', subServices: ['Bedside Attendant', 'Companion Care', 'Hygiene & Feeding Assistance'] },
      { name: 'Baby Care at Home', code: 'ACARE_BABY_CARE_HOME', subServices: ['Newborn Care Specialist', 'Post-Natal Mother Support', 'Lactation Assistance'] },
      { name: 'ICU Setup & Ryle\'s Tube Feeding at Home', code: 'ACARE_ICU_SETUP_HOME', subServices: ['Home ICU Ventilator Setup', 'Ryle\'s Tube Insertion & Feeding', 'Infusion Pump Setup', 'Critical Care Nurse'] },
      { name: 'Physiotherapy at Home', code: 'ACARE_PHYSIO_HOME', subServices: ['Orthopedic Rehabilitation', 'Stroke Recovery Physio', 'Chest Physiotherapy', 'Geriatric Mobility'] },
      { name: 'Ayurveda Therapy & Pain Management', code: 'ACARE_AYURVEDA_HOME', subServices: ['Abhyanga / Panchakarma Massage', 'Kizhi Therapy', 'Joint Pain Management', 'Herbal Steam Setup'] },
      { name: 'Diagnostics at Home', code: 'ACARE_DIAGNOSTICS_HOME', subServices: ['Blood Sample Collection', 'Home ECG', 'Holter Monitor Setup', 'Portable X-Ray'] },
      { name: 'Medicine Delivery at Home', code: 'ACARE_MEDICINE_DELIVERY', subServices: ['Monthly Chronic Meds Refill', 'Emergency Prescription Delivery', 'Cold-Chain Insulin/Biologicals'] },
      { name: 'Wound Care at Home', code: 'ACARE_WOUND_CARE_HOME', subServices: ['Diabetic Foot Ulcer Care', 'Surgical Wound Dressing', 'Vacuum-Assisted Closure (VAC)'] },
      { name: 'Medical & Surgical Equipment — Rental & Purchase', code: 'ACARE_EQUIPMENT', subServices: ['Hospital Bed (Manual/Motorized)', 'Oxygen Concentrator', 'BiPAP / CPAP Machine', 'Suction Machine', 'Wheelchair Rental'] },
      { name: 'Ambulance Services', code: 'ACARE_AMBULANCE', isEmergency: true, subServices: ['Emergency Cardiac Ambulance', 'Basic Life Support (BLS)', 'Advance Life Support (ALS)', 'Patient Transport'] },
      { name: 'Errand & Support Services', code: 'ACARE_ERRAND_SUPPORT', subServices: ['Hospital Companion / Escort', 'Banking & Pharmacy Errands', 'Grocery Delivery Support'] },
      { name: 'Funeral & Last Rites Assistance Services', code: 'ACARE_FUNERAL_LAST_RITES', subServices: ['Freezer Box Provision', 'Hearse Van Service', 'Cremation / Burial Coordination', 'Priest & Ritual Arrangement'] },
    ],
  },
  {
    key: 'AMBULANCE',
    name: 'Ambulance Services',
    category: 'Emergency & Transport Services',
    services: [
      {
        name: 'Emergency Ambulance Service',
        code: 'AMB_EMERGENCY',
        isEmergency: true,
        description: 'Priority critical response ambulance dispatch with paramedic on board.',
        subServices: ['Emergency ALS Dispatch', 'Oxygen & Defibrillator Support', 'Doctor On-Call Link'],
      },
      {
        name: 'Critical Care Ambulance (ICU on Wheels)',
        code: 'AMB_ICU_WHEELS',
        isEmergency: true,
        description: 'Mobile Intensive Care Unit equipped with ventilator and emergency physician.',
        subServices: ['Ventilator Transport', 'Cardiac Monitoring', 'Syringe Pumps & Resuscitation'],
      },
      {
        name: 'Patient Transport Ambulance',
        code: 'AMB_PATIENT_TRANSPORT',
        isEmergency: false,
        description: 'Scheduled non-emergency transport between home, diagnostic center, and hospital.',
        subServices: ['Wheelchair Transport', 'Stretcher Transport', 'Dialysis Schedule Transfer'],
      },
      {
        name: 'Outstation Ambulance Transfer',
        code: 'AMB_OUTSTATION_TRANSFER',
        isEmergency: false,
        description: 'Inter-city and long-distance patient transfer with continuous clinical monitoring.',
        subServices: ['Inter-District Transfer', 'Inter-State Transfer', 'Dedicated Nurse & Driver Pair'],
      },
    ],
  },
  {
    key: 'UHC',
    name: 'Universal Home Care (UHC)',
    category: 'Home Healthcare Services',
    services: [
      { name: 'Home Nursing Care', code: 'UHC_NURSING', subServices: ['Daily Nurse Visit', 'Medication Administration', 'Vitals Check'] },
      { name: 'Doctor Visit at Home', code: 'UHC_DOCTOR', subServices: ['Physician Assessment', 'Geriatric Checkup', 'Prescription Review'] },
      { name: 'Home Care Attendant', code: 'UHC_ATTENDANT', subServices: ['12h Day Care', '12h Night Care', '24h Live-in'] },
      { name: 'Diagnostic Sample Collection', code: 'UHC_DIAGNOSTICS', subServices: ['Fasting Blood Sample', 'Urine Sample Collection', 'ECG at Home'] },
    ],
  },
  {
    key: 'THATHA_PATTI',
    name: 'Thatha Patti Elders Foundation',
    category: 'Elders Community & Care',
    services: [
      { name: 'Assisted Living', code: 'TP_ASSISTED_LIVING', subServices: ['Senior Living Suites', 'Community Meals', 'Activity Centers'] },
      { name: 'Senior Day Care / Day Scholar', code: 'TP_DAY_CARE', subServices: ['Morning to Evening Care', 'Recreational Activities', 'Daytime Supervision'] },
      { name: 'Geriatric & Rehabilitation Care', code: 'TP_REHABILITATION', subServices: ['Physiotherapy Sessions', 'Occupational Therapy', 'Social Engagement'] },
    ],
  },
  {
    key: 'ZENCURA',
    name: 'Zencura',
    category: 'Holistic Elder Wellness',
    services: [
      { name: 'Holistic Elder Wellness', code: 'ZC_WELLNESS', subServices: ['Nutritional Guidance', 'Gentle Yoga & Breathing', 'Mental Wellness Coaching'] },
      { name: 'Memory Care Program', code: 'ZC_MEMORY_CARE', subServices: ['Cognitive Stimulation Games', 'Music Therapy', 'Reminiscence Therapy'] },
      { name: 'Preventive Health Checkup Packages', code: 'ZC_HEALTH_PACKAGES', subServices: ['Annual Senior Comprehensive Screen', 'Fall Risk Assessment', 'Bone Density Check'] },
    ],
  },
];

export const CARE_CONFIG = {
  engagementTypes: [
    'One-time Care',
    'Regular Daily Care',
    'Day Care / Day Scholar',
    'Residential Care',
    'Shift-based Care',
  ],
  durationCategories: [
    { id: 'DAY_CARE', label: 'Day Care (Single day / day-scholar)' },
    { id: 'SHORT_TERM', label: 'Short-term Care (Up to 30 days)' },
    { id: 'LONG_TERM', label: 'Long-term Care (Beyond 30 days)' },
  ],
  shortTermDurations: [
    '1 day',
    '2 days',
    '3 days',
    '4 days',
    '5 days',
    '6 days',
    '7 days',
    '14 days',
    '21 days',
    '30 days',
    'Other specified duration',
  ],
  longTermDurations: [
    '1 month',
    '3 months',
    '6 months',
    '10 months',
    '12 months',
    'Other specified duration',
    'Custom contract duration',
  ],
  careSchedules: [
    '12-hour care (Day shift: 8 AM - 8 PM)',
    '12-hour care (Night shift: 8 PM - 8 AM)',
    '24-hour care (Full-day live-in)',
    'Custom shift',
    'Daytime schedule',
    'Night-time schedule',
    'Custom schedule',
  ],
  mobilityOptions: [
    'Fully Independent',
    'Needs Partial Assistance (Walker / Cane)',
    'Wheelchair Bound',
    'Bedridden (Requires Complete Assistance)',
  ],
  enquiryCategories: [
    { value: 'SERVICE_ENQUIRY', label: 'Service Enquiry' },
    { value: 'JOB_ENQUIRY', label: 'Job Enquiry / Careers' },
    { value: 'VOLUNTEER_ENQUIRY', label: 'Volunteer Enquiry' },
    { value: 'DONOR_ENQUIRY', label: 'Donor Enquiry' },
    { value: 'GENERAL_ENQUIRY', label: 'General Enquiry' },
    { value: 'COMPLAINT_OR_SUPPORT', label: 'Complaint / Support' },
  ],
};
