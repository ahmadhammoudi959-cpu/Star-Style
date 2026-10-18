import type { Dict } from "./de";

const ar: Dict = {
  app: { name: "Star Style", tagline: "المخزن · المبيعات · الفواتير" },
  common: {
    save: "حفظ", cancel: "إلغاء", back: "رجوع", add: "إضافة", edit: "تعديل",
    delete: "حذف", search: "بحث …", actions: "إجراءات", yes: "نعم", no: "لا", none: "—",
    required: "حقل مطلوب", saved: "تم الحفظ", error: "صار خطأ، جرّب مرة تانية", all: "الكل",
    date: "التاريخ", note: "ملاحظة", qty: "الكمية", total: "المجموع", optional: "اختياري", logout: "تسجيل الخروج",
    active: "فعّال", inactive: "غير فعّال", details: "التفاصيل", close: "إغلاق", remove: "إزالة",
    language: "اللغة", nothingYet: "ما في شي لسا", confirm: "تأكيد",
  },
  nav: {
    home: "الرئيسية", products: "المنتجات", receive: "إدخال بضاعة", stock: "المخزون", writeOffs: "التالف",
    suppliers: "الموردين", settings: "الإعدادات", sales: "المبيعات", reports: "التقارير", expenses: "المصاريف",
  },
  home: {
    greeting: "أهلاً", subtitle: "شو بدك تعمل اليوم؟",
    sell: "بيع", sellHint: "عرض سعر أو فاتورة",
    receive: "إدخال بضاعة", receiveHint: "تسجيل شحنة جديدة",
    loss: "مصروف أو تالف", lossHint: "كسر، انتهاء صلاحية، مصاريف",
    reports: "التقارير", reportsHint: "المبيعات والأرباح",
    stockValue: "قيمة المخزون", lowStock: "كمية قليلة", expiring: "قرّبت تنتهي صلاحيته", articles: "منتج",
    alerts: "تنبيهات", noAlerts: "كل شي تمام، ما في تنبيهات.", comingSoon: "بالمرحلة التانية",
  },
  login: {
    title: "تسجيل الدخول", email: "الإيميل", password: "كلمة السر", submit: "دخول", invalid: "الإيميل أو كلمة السر غلط.",
  },
  setup: {
    title: "الإعداد الأول", intro: "اعمل حسابك وعبّي بيانات الشركة. هالخطوة بتصير مرة وحدة بس.",
    account: "حسابك", name: "الاسم", company: "الشركة", companyName: "اسم الشركة", vatId: "الرقم الضريبي",
    street: "الشارع والرقم", zip: "الرمز البريدي", city: "المدينة", submit: "ابدأ",
    passwordHint: "١٠ أحرف على الأقل", alreadyDone: "الإعداد خالص من قبل.",
  },
  product: {
    title: "المنتجات", new: "منتج جديد", edit: "تعديل المنتج", sku: "رقم المنتج",
    nameDe: "الاسم بالألماني", nameNl: "الاسم بالهولندي", descDe: "الوصف بالألماني", descNl: "الوصف بالهولندي",
    category: "التصنيف", supplier: "المورّد", vat: "الضريبة", purchase: "سعر الشراء بدون ضريبة", wholesale: "سعر الجملة بدون ضريبة",
    retail: "سعر المفرق بدون ضريبة", tracksExpiry: "إله تاريخ صلاحية", shops: "بينعرض بـ", brandShop: "متجر البراند",
    generalShop: "المتجر العام", variants: "المقاسات والألوان", size: "المقاس", color: "اللون", barcode: "الباركود",
    minStock: "الحد الأدنى", stock: "الكمية", addVariant: "إضافة مقاس أو لون", noVariantsHint: "إذا ما في مقاس أو لون، اترك سطر واحد فاضي.",
    skuTaken: "رقم المنتج هاد موجود من قبل.", barcodeTaken: "الباركود هاد مستخدم من قبل.", duplicateVariant: "نفس المقاس واللون مكرر.",
    variantHasStock: "ما فيك تشيل مقاس أو لون إله كمية بالمخزون.", empty: "ما في منتجات لسا. ضيف أول منتج.", margin: "هامش الربح", reserved: "محجوز", available: "متاح",
  },
  receive: {
    title: "إدخال بضاعة", new: "شحنة جديدة", supplier: "المورّد", supplierInvoice: "رقم فاتورة المورّد",
    lines: "البنود", pickProduct: "دوّر على منتج بالاسم أو الرقم أو الباركود", unitCost: "سعر شراء القطعة", batchNo: "رقم الدفعة",
    expiry: "تاريخ الصلاحية", addLine: "إضافة بند", submit: "تسجيل البضاعة", booked: "تم تسجيل البضاعة",
    expiryRequired: "هالمنتج لازمه تاريخ صلاحية.", history: "آخر الشحنات", number: "الرقم",
    items: "البنود", value: "القيمة",
  },
  stock: {
    title: "المخزون", movements: "الحركات", value: "قيمة المخزون بسعر الشراء", low: "تحت الحد الأدنى", filterLow: "بس الكميات القليلة",
    type: { RECEIPT: "إدخال", SALE: "بيع", RETURN: "إرجاع", WRITE_OFF: "تالف", ADJUSTMENT: "جرد", CANCEL: "إلغاء" },
    adjust: "تصحيح بالجرد", counted: "العدد الحقيقي", adjustReason: "السبب", adjusted: "تم تصحيح الكمية",
    avgCost: "متوسط سعر الشراء", batches: "الدفعات", expiresIn: "بتنتهي بعد {d} يوم", expired: "منتهية",
  },
  writeOff: {
    title: "التالف والخسائر", new: "تسجيل تالف", reason: "السبب",
    reasons: { BREAKAGE: "كسر", DAMAGE: "تلف", EXPIRED: "انتهاء صلاحية", LOSS: "ضياع", OTHER: "غير ذلك" },
    photo: "صورة", submit: "تسجيل التالف", booked: "تم تسجيل التالف", notEnough: "الكمية بالمخزون ما بتكفي", protocol: "المحضر",
    value: "القيمة بسعر الشراء",
  },
  supplier: {
    title: "الموردين", new: "مورّد جديد", name: "الاسم", contact: "الشخص المسؤول", email: "الإيميل", phone: "التلفون",
    country: "البلد", vatId: "الرقم الضريبي", empty: "ما في موردين لسا.",
  },
  settings: {
    title: "الإعدادات", company: "بيانات الشركة", bank: "البنك", invoice: "الفواتير", owner: "صاحب الشركة",
    taxNumber: "الرقم الضريبي المحلي", bankName: "اسم البنك", iban: "رقم الحساب الدولي", bic: "رمز البنك", paymentDays: "مهلة الدفع بالأيام",
    offerDays: "صلاحية العرض بالأيام", footer: "النص بأسفل الفاتورة", website: "الموقع",
  },
};
export default ar;
